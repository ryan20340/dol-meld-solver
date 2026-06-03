import { buildXivIconUrl, normalizeIconId } from "../utils/icons.js";
import { normalizeNonNegativeInteger, normalizeOptionalPriority } from "../utils/normalize.js";
import { hasAnyTargets, STAT_KEYS } from "../utils/stats.js";

const IMAGE_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const INITIAL_DROPDOWN_PRELOAD_COUNT = 12;
const STAT_DISPLAY = Object.freeze({
  gathering: "Gathering",
  perception: "Perception",
  gp: "GP",
});
const ADVANCED_STAT_DUMP_OPTIONS = Object.freeze({
  none: "None",
  gathering: "Gathering",
  perception: "Perception",
  gp: "GP",
  even: "Evenly Distributed",
});
const GRADE_ROMAN = Object.freeze(["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]);
const SLOT_DISPLAY = Object.freeze({
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
const LEFT_SLOT_ORDER = ["main_hand", "head", "body", "hands", "legs", "feet"];
const LEFT_SLOT_SET = new Set(LEFT_SLOT_ORDER);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildItemIconHtml(iconId, label, className = "item-icon", options = {}) {
  const normalized = normalizeIconId(iconId);
  if (normalized <= 0) {
    if (options?.includePlaceholder === false) {
      return "";
    }
    return `<span class="${className} item-icon-placeholder" aria-hidden="true"></span>`;
  }

  const src = buildXivIconUrl(normalized, {
    useHqVariant: options?.useHqVariant === true,
  });
  const alt = `${String(label ?? "Item")} icon`;
  return `<img class="${className}" src="${src}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`;
}

function buildIconIdByItemId(rows, itemIdKey) {
  const iconIdByItemId = new Map();
  const sourceRows = Array.isArray(rows) ? rows : [];
  for (const row of sourceRows) {
    const itemId = normalizeNonNegativeInteger(row?.[itemIdKey]);
    if (itemId <= 0) {
      continue;
    }
    iconIdByItemId.set(itemId, normalizeIconId(row?.icon_id ?? row?.iconId));
  }
  return iconIdByItemId;
}

function buildCanBeHqByItemId(rows, itemIdKey) {
  const canBeHqByItemId = new Map();
  const sourceRows = Array.isArray(rows) ? rows : [];
  for (const row of sourceRows) {
    const itemId = normalizeNonNegativeInteger(row?.[itemIdKey]);
    if (itemId <= 0) {
      continue;
    }
    canBeHqByItemId.set(itemId, row?.can_be_hq === true);
  }
  return canBeHqByItemId;
}

function resolveIconIdFromItemMap(iconIdByItemId, itemId) {
  if (!(iconIdByItemId instanceof Map)) {
    return 0;
  }
  return normalizeIconId(iconIdByItemId.get(normalizeNonNegativeInteger(itemId)));
}

function resolveCanBeHqFromItemMap(canBeHqByItemId, itemId) {
  if (!(canBeHqByItemId instanceof Map)) {
    return false;
  }
  return canBeHqByItemId.get(normalizeNonNegativeInteger(itemId)) === true;
}

function buildRenderIconContext(state) {
  const gearRows = Array.isArray(state?.data?.gear?.rows) ? state.data.gear.rows : [];
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  return {
    gearIconIdByItemId: buildIconIdByItemId(gearRows, "id"),
    foodIconIdByItemId: buildIconIdByItemId(foodRows, "item_id"),
    gearCanBeHqByItemId: buildCanBeHqByItemId(gearRows, "id"),
    foodCanBeHqByItemId: buildCanBeHqByItemId(foodRows, "item_id"),
    gearUseHq: state?.gear?.useHq === true,
  };
}

function formatTotalVsCap(total, cap) {
  const safeTotal = normalizeNonNegativeInteger(total);
  const safeCap = normalizeNonNegativeInteger(cap);
  if (safeCap > 0) {
    return `${safeTotal}/${safeCap}`;
  }
  return `${safeTotal}`;
}

function gradeToRoman(grade) {
  return GRADE_ROMAN[Math.max(0, Math.min(Number(grade) || 0, GRADE_ROMAN.length - 1))] || String(grade);
}

function buildTotalsCell(row, targets) {
  const totals = {
    gathering: normalizeNonNegativeInteger(row?.totalGathering),
    perception: normalizeNonNegativeInteger(row?.totalPerception),
    gp: normalizeNonNegativeInteger(row?.totalGp),
  };
  const targetValues = {
    gathering: normalizeNonNegativeInteger(targets?.gathering),
    perception: normalizeNonNegativeInteger(targets?.perception),
    gp: normalizeNonNegativeInteger(targets?.gp),
  };

  const hasTargets = STAT_KEYS.some((key) => targetValues[key] > 0);
  const excess = {
    gathering: totals.gathering - targetValues.gathering,
    perception: totals.perception - targetValues.perception,
    gp: totals.gp - targetValues.gp,
  };
  const excessText = hasTargets
    ? `Excess: G ${excess.gathering >= 0 ? `+${excess.gathering}` : excess.gathering}, ` +
      `P ${excess.perception >= 0 ? `+${excess.perception}` : excess.perception}, ` +
      `GP ${excess.gp >= 0 ? `+${excess.gp}` : excess.gp}`
    : "Excess: n/a (no targets set)";

  return `
    <div class="plan-totals">
      <span><strong>G</strong> ${formatTotalVsCap(totals.gathering, targetValues.gathering)}</span>
      <span><strong>P</strong> ${formatTotalVsCap(totals.perception, targetValues.perception)}</span>
      <span><strong>GP</strong> ${formatTotalVsCap(totals.gp, targetValues.gp)}</span>
      <span class="plan-excess muted">${escapeHtml(excessText)}</span>
    </div>
  `;
}

function formatBreakpointTargets(entry) {
  const stat = String(entry?.stat ?? "");
  const label = { gathering: "G", perception: "P", gp: "GP" }[stat] ?? stat.toUpperCase();
  const priority = normalizeOptionalPriority(entry?.priority);
  const priorityLabel = priority == null ? "Unnumbered" : `P${priority}`;
  return `${priorityLabel} | ${label} >= ${normalizeNonNegativeInteger(entry?.value)}`;
}

function signedDeltaLabel(value) {
  const safe = Number(value) || 0;
  return safe >= 0 ? `+${safe}` : String(safe);
}

function highestBreakpointTargetsByStat(profile) {
  const rows = Array.isArray(profile?.breakpointResults) ? profile.breakpointResults : [];
  const targets = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };

  for (const stat of STAT_KEYS) {
    targets[stat] = rows
      .filter((row) => String(row?.stat ?? "") === stat)
      .reduce((maxValue, row) => Math.max(maxValue, normalizeNonNegativeInteger(row?.value)), 0);
  }
  return targets;
}

function buildExcessStatLine(profile) {
  const profileName = String(profile?.profileName ?? "Profile");
  const totals = {
    gathering: normalizeNonNegativeInteger(profile?.totals?.gathering),
    perception: normalizeNonNegativeInteger(profile?.totals?.perception),
    gp: normalizeNonNegativeInteger(profile?.totals?.gp),
  };
  const highestTargets = highestBreakpointTargetsByStat(profile);
  const excess = {
    gathering: totals.gathering - highestTargets.gathering,
    perception: totals.perception - highestTargets.perception,
    gp: totals.gp - highestTargets.gp,
  };

  return `<span><strong>Excess Stat - ${escapeHtml(profileName)}</strong> G ${signedDeltaLabel(excess.gathering)} P ${signedDeltaLabel(excess.perception)} GP ${signedDeltaLabel(excess.gp)}</span>`;
}

function buildAdvancedProfileSummary(profile) {
  const food = profile?.food;
  const foodQuality = food?.useHq ? "HQ" : "NQ";
  const foodLabel = food ? `${food.name} [${foodQuality}]` : "No food";
  const dumpLabel = statDumpLabel(profile?.statDump);
  const totals = {
    gathering: normalizeNonNegativeInteger(profile?.totals?.gathering),
    perception: normalizeNonNegativeInteger(profile?.totals?.perception),
    gp: normalizeNonNegativeInteger(profile?.totals?.gp),
  };
  const breakpointRows = Array.isArray(profile?.breakpointResults) ? profile.breakpointResults : [];
  const breakpointHtml =
    breakpointRows.length === 0
      ? '<li class="muted">No enabled breakpoints for this profile.</li>'
      : breakpointRows
          .map((entry) => {
            const badgeClass = entry?.hit ? "advanced-bp-hit" : "advanced-bp-miss";
            const mark = entry?.hit ? "✓" : "✗";
            const label = String(entry?.name ?? "Breakpoint");
            const targetSummary = formatBreakpointTargets(entry);
            return `
              <li class="${badgeClass}">
                <span>${escapeHtml(mark)}</span>
                <span>${escapeHtml(label)}</span>
                <span class="muted">${escapeHtml(targetSummary)}</span>
              </li>
            `;
          })
          .join("");

  return `
    <div class="advanced-profile-result">
      <p><strong>${escapeHtml(profile?.profileName ?? "Profile")}</strong> | Breakpoints ${normalizeNonNegativeInteger(profile?.breakpointsMet)}/${normalizeNonNegativeInteger(profile?.enabledBreakpoints)} | Dump ${escapeHtml(dumpLabel)} | Food ${escapeHtml(foodLabel)} | Totals G ${totals.gathering} P ${totals.perception} GP ${totals.gp}</p>
      <ul class="advanced-breakpoint-list">
        ${breakpointHtml}
      </ul>
    </div>
  `;
}

function buildAdvancedCell(row) {
  const advanced = row?.advanced ?? {};
  const breakpointsMet = normalizeNonNegativeInteger(advanced?.breakpointsMet);
  const breakpointsEnabled = normalizeNonNegativeInteger(advanced?.breakpointsEnabled);
  const baseTotals = {
    gathering: normalizeNonNegativeInteger(advanced?.baseTotals?.gathering),
    perception: normalizeNonNegativeInteger(advanced?.baseTotals?.perception),
    gp: normalizeNonNegativeInteger(advanced?.baseTotals?.gp),
  };
  const profiles = Array.isArray(advanced?.profiles) ? advanced.profiles : [];
  const profileHtml =
    profiles.length === 0
      ? '<p class="muted">No advanced profiles configured.</p>'
      : profiles.map((profile) => buildAdvancedProfileSummary(profile)).join("");
  const excessStatsHtml =
    profiles.length === 0
      ? '<span class="muted">Excess Stat: n/a</span>'
      : profiles.map((profile) => buildExcessStatLine(profile)).join("");

  return `
    <div class="advanced-summary">
      <div class="plan-hit ${breakpointsMet > 0 ? "hit" : "miss"}">
        Breakpoints ${breakpointsMet}/${breakpointsEnabled}
      </div>
      <div class="plan-totals">
        <span><strong>Base (No Food)</strong> G ${baseTotals.gathering}</span>
        <span>P ${baseTotals.perception}</span>
        <span>GP ${baseTotals.gp}</span>
      </div>
      <div class="plan-totals">
        ${excessStatsHtml}
      </div>
      ${profileHtml}
    </div>
  `;
}

function normalizeAdvancedProfile(raw, index = 0) {
  return {
    id: String(raw?.id ?? `profile_${index + 1}`),
    name: String(raw?.name ?? `Profile ${index + 1}`),
    enabled: raw?.enabled !== false,
    useHq: raw?.useHq !== false,
    statDump: normalizeAdvancedStatDump(raw?.statDump),
    allowedFoodIds: Array.isArray(raw?.allowedFoodIds)
      ? raw.allowedFoodIds.map((value) => normalizeNonNegativeInteger(value)).filter((value) => value > 0)
      : [],
    breakpoints: Array.isArray(raw?.breakpoints) ? raw.breakpoints : [],
  };
}

function normalizeAdvancedBreakpoint(raw, index = 0) {
  const rawStat = String(raw?.stat ?? "");
  const stat = STAT_KEYS.includes(rawStat) ? rawStat : "gathering";
  const fallbackName = `Breakpoint ${index + 1}`;
  const priority = normalizeOptionalPriority(raw?.priority);
  return {
    id: String(raw?.id ?? `bp_${index + 1}`),
    name: String(raw?.name ?? fallbackName).trim() || fallbackName,
    stat,
    value: normalizeNonNegativeInteger(raw?.value),
    priority,
    enabled: raw?.enabled !== false,
  };
}

function buildAdvancedFoodSection(profile, foodRows, profileIndex) {
  if (!Array.isArray(foodRows) || foodRows.length === 0) {
    return '<p class="muted">No food rows loaded.</p>';
  }

  const allowedSet = new Set(
    (Array.isArray(profile?.allowedFoodIds) ? profile.allowedFoodIds : [])
      .map((value) => normalizeNonNegativeInteger(value))
      .filter((value) => value > 0),
  );

  const sortedRows = [...foodRows].sort((a, b) => {
    const ilvDiff = (Number(b?.item_level) || 0) - (Number(a?.item_level) || 0);
    if (ilvDiff !== 0) return ilvDiff;
    return String(a?.name ?? "").localeCompare(String(b?.name ?? ""));
  });
  const profileUseHq = profile?.useHq === true;

  const pid = escapeHtml(String(profileIndex));

  const selectedHtml =
    allowedSet.size === 0
      ? '<p class="muted advanced-food-all-note">All foods considered (no restriction).</p>'
      : sortedRows
          .filter((row) => allowedSet.has(normalizeNonNegativeInteger(row?.item_id)))
          .map((row) => {
            const foodId = normalizeNonNegativeInteger(row?.item_id);
            const iconHtml = buildItemIconHtml(
              normalizeIconId(row?.icon_id),
              row?.name ?? `Food ${foodId}`,
              "item-icon item-icon-chip",
              { useHqVariant: profileUseHq && row?.can_be_hq === true },
            );
            return `
              <div class="advanced-food-chip">
                ${iconHtml}
                <span>${escapeHtml(row?.name ?? `Food ${foodId}`)} (i${row?.item_level ?? "?"})</span>
                <button
                  type="button"
                  class="advanced-food-chip-remove"
                  data-action="advanced-food-remove"
                  data-profile-index="${pid}"
                  data-food-id="${foodId}"
                  title="Remove"
                >×</button>
              </div>
            `;
          })
          .join("");

  const dropdownOptions = sortedRows
    .filter((row) => !allowedSet.has(normalizeNonNegativeInteger(row?.item_id)))
    .map((row) => {
      const foodId = normalizeNonNegativeInteger(row?.item_id);
      return `<option value="${foodId}">${escapeHtml(row?.name ?? `Food ${foodId}`)} (i${row?.item_level ?? "?"})</option>`;
    })
    .join("");

  return `
    <div class="advanced-food-selected">${selectedHtml}</div>
    <select
      class="advanced-food-add-select"
      data-action="advanced-food-add"
      data-profile-index="${pid}"
    >
      <option value="0" selected disabled>+ Add food…</option>
      ${dropdownOptions}
    </select>
  `;
}

function buildAdvancedBreakpointEditor(profile, profileIndex) {
  const breakpoints = (Array.isArray(profile?.breakpoints) ? profile.breakpoints : [])
    .map((entry, index) => normalizeAdvancedBreakpoint(entry, index));
  const grid =
    breakpoints.length === 0
      ? '<p class="muted">No breakpoints yet. Add one to start scoring.</p>'
      : `<div class="advanced-breakpoints-grid">${breakpoints
          .map((bp) => {
            const pid = escapeHtml(String(profileIndex));
            const bpid = escapeHtml(bp.id);
            const priorityValue = bp.priority == null ? "" : String(bp.priority);
            return `
              <div class="advanced-breakpoint-row">
                <div class="advanced-bp-top">
                  <input
                    type="checkbox"
                    class="advanced-bp-check"
                    data-advanced-breakpoint-enabled="1"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                    title="Enabled"
                    ${bp.enabled ? "checked" : ""}
                  >
                  <input
                    type="text"
                    class="advanced-bp-name"
                    data-advanced-breakpoint-field="name"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                    value="${escapeHtml(bp.name)}"
                    maxlength="80"
                    placeholder="Name"
                  >
                  <button
                    type="button"
                    class="advanced-bp-remove"
                    data-action="advanced-breakpoint-remove"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                    title="Remove"
                  >×</button>
                </div>
                <div class="advanced-bp-bottom">
                  <select
                    class="advanced-bp-stat"
                    data-advanced-breakpoint-field="stat"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                  >
                    <option value="gathering" ${bp.stat === "gathering" ? "selected" : ""}>Gathering</option>
                    <option value="perception" ${bp.stat === "perception" ? "selected" : ""}>Perception</option>
                    <option value="gp" ${bp.stat === "gp" ? "selected" : ""}>GP</option>
                  </select>
                  <span class="advanced-bp-gte">≥</span>
                  <input
                    type="number"
                    class="advanced-bp-value"
                    min="0"
                    data-advanced-breakpoint-field="value"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                    value="${bp.value}"
                  >
                  <input
                    type="number"
                    class="advanced-bp-value"
                    step="1"
                    data-advanced-breakpoint-field="priority"
                    data-profile-index="${pid}"
                    data-breakpoint-id="${bpid}"
                    value="${escapeHtml(priorityValue)}"
                    placeholder="Priority"
                    title="Optional priority (higher is more important)"
                  >
                </div>
              </div>
            `;
          })
          .join("")}</div>`;
  return `
    <div class="advanced-breakpoints">
      <div class="advanced-section-head">
        <h4>Breakpoints</h4>
        <button type="button" data-action="advanced-breakpoint-add" data-profile-index="${profileIndex}">+ Add</button>
      </div>
      ${grid}
    </div>
  `;
}

function buildAdvancedConfigPanel(state) {
  const advanced = state?.advanced ?? {};
  const rawProfiles = Array.isArray(advanced?.profiles) ? advanced.profiles : [normalizeAdvancedProfile(null, 0)];
  const profiles = rawProfiles.map((profile, idx) => normalizeAdvancedProfile(profile, idx));
  const activeProfileIndex = Math.min(
    Math.max(0, profiles.length - 1),
    normalizeNonNegativeInteger(advanced?.activeProfileIndex),
  );
  const activeProfile = profiles[activeProfileIndex] ?? normalizeAdvancedProfile(null, 0);
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  const canDeleteProfile = profiles.length > 1;
  const tabs = `
    <div class="advanced-section-head">
      <h4>Profiles</h4>
      <div class="button-row">
        <button type="button" data-action="advanced-profile-add" title="Add profile">+</button>
        <button
          type="button"
          data-action="advanced-profile-copy"
          data-profile-index="${activeProfileIndex}"
          title="Copy active profile"
          aria-label="Copy active profile"
        >&#x29C9;</button>
        <button type="button" data-action="advanced-preset-load-75" title="Load current advanced preset">7.5 Preset</button>
        <button
          type="button"
          data-action="advanced-profile-remove"
          data-profile-index="${activeProfileIndex}"
          title="Delete active profile"
          ${canDeleteProfile ? "" : "disabled"}
        >Delete Profile</button>
      </div>
    </div>
    <div class="advanced-profile-tabs">
      ${profiles
        .map((profile, index) => {
          const activeClass = index === activeProfileIndex ? "advanced-profile-tab active" : "advanced-profile-tab";
          const disabledSuffix = profile?.enabled === false ? " (off)" : "";
          return `<button type="button" class="${activeClass}" data-action="advanced-profile-tab" data-profile-index="${index}">${escapeHtml(profile.name)}${escapeHtml(disabledSuffix)}</button>`;
        })
        .join("")}
    </div>
  `;

  const bodyHtml =
    advanced?.enabled === true
      ? `
        ${tabs}
        <div class="advanced-profile-panel">
          <div class="input-row input-row-wide">
            <label>Profile Name</label>
            <input
              type="text"
              data-advanced-profile-name="1"
              data-profile-index="${activeProfileIndex}"
              value="${escapeHtml(activeProfile?.name ?? `Profile ${activeProfileIndex + 1}`)}"
              maxlength="120"
            >
          </div>
          <div class="advanced-profile-toggle-row">
            <label class="checkbox-row advanced-profile-toggle">
              <input
                type="checkbox"
                data-action="advanced-profile-enabled"
                data-profile-index="${activeProfileIndex}"
                ${activeProfile?.enabled !== false ? "checked" : ""}
              >
              <span>Use this profile in solve ranking</span>
            </label>
            <label class="checkbox-row advanced-profile-toggle">
              <input
                type="checkbox"
                data-advanced-profile-hq="1"
                data-profile-index="${activeProfileIndex}"
                ${activeProfile?.useHq !== false ? "checked" : ""}
              >
              <span>Use HQ values for this profile</span>
            </label>
          </div>
          <div class="input-row input-row-wide">
            <label>Stat Dump</label>
            <select
              data-advanced-profile-stat-dump="1"
              data-profile-index="${activeProfileIndex}"
            >
              <option value="none" ${activeProfile?.statDump === "none" ? "selected" : ""}>None</option>
              <option value="gathering" ${activeProfile?.statDump === "gathering" ? "selected" : ""}>Gathering</option>
              <option value="perception" ${activeProfile?.statDump === "perception" ? "selected" : ""}>Perception</option>
              <option value="gp" ${activeProfile?.statDump === "gp" ? "selected" : ""}>GP</option>
              <option value="even" ${activeProfile?.statDump === "even" ? "selected" : ""}>Evenly Distributed</option>
            </select>
          </div>
        </div>
        ${buildAdvancedBreakpointEditor(activeProfile, activeProfileIndex)}
        <div class="advanced-food">
          <h4>Allowed Food</h4>
          ${buildAdvancedFoodSection(activeProfile, foodRows, activeProfileIndex)}
        </div>
      `
      : '<p class="muted">Enable advanced mode to configure breakpoint and food profiles.</p>';

  return `
    <section class="subpanel advanced-main-panel" aria-label="Advanced mode">
      <h3>Advanced Mode</h3>
      <label class="checkbox-row" for="advanced-main-enabled">
        <input id="advanced-main-enabled" type="checkbox" data-advanced-toggle-enabled="1" ${advanced?.enabled ? "checked" : ""}>
        <span>Enable advanced mode</span>
      </label>
      ${bodyHtml}
    </section>
  `;
}

function meldDotClass(meld) {
  const isOvermeld = Boolean(meld?.isOvermeld);
  const overmeldIndex = Number(meld?.overmeldIndex ?? -1);
  return isOvermeld
    ? overmeldIndex === 0 ? "meld-dot overmeld-first" : "meld-dot overmeld"
    : "meld-dot guaranteed";
}

// Render a single read-only meld row. `extraClass`/`marker` carry the before/after
// diff styling (red "before" row, green "after" row); both are empty for a plain row.
function buildMeldDisplayLine(meld, extraClass = "", marker = "") {
  const statLabel = STAT_DISPLAY[meld?.stat] ?? String(meld?.stat ?? "").toUpperCase();
  const applied = Number(meld?.appliedValue) || 0;
  const raw = Number(meld?.rawValue) || 0;
  const grade = Number(meld?.grade) || 0;
  const cappedNote = raw !== applied ? ` <span class="muted">(raw +${raw})</span>` : "";
  const markerHtml = marker ? `<span class="meld-diff-marker">${escapeHtml(marker)}</span>` : "";
  const lineClass = extraClass ? `meld-line ${extraClass}` : "meld-line";
  return `
    <li class="${lineClass}">
      <span class="${escapeHtml(meldDotClass(meld))}"></span>
      ${markerHtml}
      <span>${escapeHtml(statLabel)} +${applied} (${escapeHtml(gradeToRoman(grade))})${cappedNote}</span>
    </li>
  `;
}

function buildMeldLine(meld, options = {}) {
  const dotClass = meldDotClass(meld);
  const applied = Number(meld?.appliedValue) || 0;
  const raw = Number(meld?.rawValue) || 0;
  const grade = Number(meld?.grade) || 0;
  const pieceIndex = normalizeNonNegativeInteger(options?.pieceIndex);
  const meldIndex = normalizeNonNegativeInteger(options?.meldIndex);
  const slotIndex = normalizeNonNegativeInteger(meld?.slotIndex, meldIndex);
  if (options?.isEditing) {
    const stat = String(meld?.stat ?? "gathering");
    const statOptions = buildStatOptionsHtml(stat);
    const legalGrades = legalGradesForMeld(stat, meld, options);
    const gradeOptions = buildGradeOptionsHtml(
      legalGrades,
      grade,
      stat,
      options?.gradeValueIndexByStat,
      raw,
    );
    const slotLabel = `Slot ${normalizeNonNegativeInteger(meld?.slotIndex) + 1}`;
    const capMeta = raw > applied
      ? `Applied +${applied} (capped, raw +${raw})`
      : `Applied +${applied}`;
    return `
      <li class="meld-line meld-line-editable">
        <span class="${escapeHtml(dotClass)}"></span>
        <span class="saved-plan-inline-slot muted">${escapeHtml(slotLabel)}</span>
        <select data-action="saved-plan-edit-stat" data-plan-id="${escapeHtml(options?.planId)}" data-piece-index="${pieceIndex}" data-meld-index="${meldIndex}">
          ${statOptions}
        </select>
        <select data-action="saved-plan-edit-grade" data-plan-id="${escapeHtml(options?.planId)}" data-piece-index="${pieceIndex}" data-meld-index="${meldIndex}">
          ${gradeOptions}
        </select>
        <span class="muted saved-plan-inline-meld-meta">${escapeHtml(capMeta)}</span>
      </li>
    `;
  }
  // Refine diff: a changed slot shows the replaced materia (red) above the new
  // one (green). A pure add has no "before" row.
  const meldChangeByKey = options?.meldChangeByKey instanceof Map ? options.meldChangeByKey : null;
  const changeRecord =
    Boolean(options?.highlightDiff) && meldChangeByKey
      ? meldChangeByKey.get(`${pieceIndex}:${slotIndex}`)
      : null;
  if (changeRecord) {
    const beforeLine = changeRecord.before
      ? buildMeldDisplayLine(changeRecord.before, "meld-line-before", "−")
      : "";
    return beforeLine + buildMeldDisplayLine(meld, "meld-line-after", "+");
  }
  return buildMeldDisplayLine(meld);
}

function legalGradesForMeld(statKey, meld, options = {}) {
  const allStatGrades = Array.isArray(options?.availableGradesByStat?.[statKey])
    ? options.availableGradesByStat[statKey]
    : [];
  if (!Boolean(meld?.isOvermeld)) {
    return allStatGrades;
  }
  const overmeldIndex = Number(meld?.overmeldIndex ?? -1);
  if (!Number.isFinite(overmeldIndex) || overmeldIndex < 0) {
    return allStatGrades;
  }
  const allowedForSlot = options?.overmeldAllowedGradesByStat?.[statKey]?.[overmeldIndex];
  if (!Array.isArray(allowedForSlot) || allowedForSlot.length === 0) {
    return allStatGrades;
  }
  const allowedSet = new Set(allowedForSlot.map((grade) => normalizeNonNegativeInteger(grade)));
  const filtered = allStatGrades.filter((grade) => allowedSet.has(normalizeNonNegativeInteger(grade)));
  return filtered.length > 0 ? filtered : allStatGrades;
}

function buildPieceCapSummary(piece) {
  const caps = {
    gathering: normalizeNonNegativeInteger(piece?.trackedMeldCaps?.gathering),
    perception: normalizeNonNegativeInteger(piece?.trackedMeldCaps?.perception),
    gp: normalizeNonNegativeInteger(piece?.trackedMeldCaps?.gp),
  };
  const used = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };

  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  for (const meld of melds) {
    const statKey = String(meld?.stat ?? "").toLowerCase();
    if (!STAT_KEYS.includes(statKey)) {
      continue;
    }
    used[statKey] += normalizeNonNegativeInteger(meld?.appliedValue);
  }

  const capProgress = STAT_KEYS
    .filter((statKey) => caps[statKey] > 0)
    .map((statKey) => `${STAT_DISPLAY[statKey]} ${used[statKey]}/${caps[statKey]}`);

  if (capProgress.length === 0) {
    return "";
  }
  return `<div class="muted piece-cap-summary"><strong>Melds:</strong> ${escapeHtml(capProgress.join(" | "))}</div>`;
}

function gearRowTrackedStatTotal(row) {
  return STAT_KEYS.reduce((total, statKey) => {
    return (
      total +
      normalizeNonNegativeInteger(row?.tracked_base_stats?.[statKey]) +
      normalizeNonNegativeInteger(row?.tracked_special_stats?.[statKey])
    );
  }, 0);
}

function gearRowTrackedStats(row, options = {}) {
  const base = {
    gathering: normalizeNonNegativeInteger(row?.tracked_base_stats?.gathering),
    perception: normalizeNonNegativeInteger(row?.tracked_base_stats?.perception),
    gp: normalizeNonNegativeInteger(row?.tracked_base_stats?.gp),
  };
  const special = {
    gathering: normalizeNonNegativeInteger(row?.tracked_special_stats?.gathering),
    perception: normalizeNonNegativeInteger(row?.tracked_special_stats?.perception),
    gp: normalizeNonNegativeInteger(row?.tracked_special_stats?.gp),
  };
  const includeSpecial = row?.can_be_hq ? options?.gearUseHq === true : true;
  if (!includeSpecial) {
    return base;
  }
  return {
    gathering: base.gathering + special.gathering,
    perception: base.perception + special.perception,
    gp: base.gp + special.gp,
  };
}

function meldTotalsForPiece(piece) {
  const totals = {
    gathering: 0,
    perception: 0,
    gp: 0,
  };
  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  for (const meld of melds) {
    const statKey = String(meld?.stat ?? "").toLowerCase();
    if (!STAT_KEYS.includes(statKey)) {
      continue;
    }
    totals[statKey] += normalizeNonNegativeInteger(meld?.appliedValue);
  }
  return totals;
}

function gearRowForPiece(piece, gearRows) {
  const pieceId = normalizeNonNegativeInteger(piece?.pieceId);
  const slotKey = String(piece?.slot ?? "");
  return (Array.isArray(gearRows) ? gearRows : []).find((row) => (
    normalizeNonNegativeInteger(row?.id) === pieceId &&
    String(row?.slot ?? "") === slotKey
  )) ?? null;
}

function buildPieceStatTotal(piece, options = {}) {
  const gearRow = gearRowForPiece(piece, options?.gearRows);
  if (!gearRow) {
    return "";
  }
  const base = gearRowTrackedStats(gearRow, options);
  const melds = meldTotalsForPiece(piece);
  const totals = {
    gathering: base.gathering + melds.gathering,
    perception: base.perception + melds.perception,
    gp: base.gp + melds.gp,
  };
  return `
    <div class="muted piece-stat-total">
      <strong>Total:</strong> G ${totals.gathering} P ${totals.perception} GP ${totals.gp}
    </div>
  `;
}

function gearRowsForSavedPlanPiece(piece, gearRows) {
  const slotKey = String(piece?.slot ?? "");
  const selectedId = normalizeNonNegativeInteger(piece?.pieceId);
  const rows = (Array.isArray(gearRows) ? gearRows : [])
    .filter((row) => String(row?.slot ?? "") === slotKey && gearRowTrackedStatTotal(row) > 0)
    .sort((left, right) => {
      const itemLevelDiff = normalizeNonNegativeInteger(right?.item_level) - normalizeNonNegativeInteger(left?.item_level);
      if (itemLevelDiff !== 0) {
        return itemLevelDiff;
      }
      const nameDiff = String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
      if (nameDiff !== 0) {
        return nameDiff;
      }
      return normalizeNonNegativeInteger(left?.id) - normalizeNonNegativeInteger(right?.id);
    });

  if (selectedId > 0 && !rows.some((row) => normalizeNonNegativeInteger(row?.id) === selectedId)) {
    rows.unshift({
      id: selectedId,
      name: String(piece?.pieceName ?? `Item ${selectedId}`),
      item_level: "?",
    });
  }

  return rows;
}

function buildSavedPlanPieceGearSelect(piece, options = {}) {
  const rows = gearRowsForSavedPlanPiece(piece, options?.gearRows);
  if (rows.length === 0) {
    return `<span>${escapeHtml(SLOT_DISPLAY[piece?.slot] ?? piece?.slot ?? "")} - ${escapeHtml(piece?.pieceName ?? "Unknown piece")}</span>`;
  }

  const selectedId = normalizeNonNegativeInteger(piece?.pieceId);
  const pieceIndex = normalizeNonNegativeInteger(options?.pieceIndex);
  const entries = rows.map((row) => {
    const itemId = normalizeNonNegativeInteger(row?.id);
    const itemLevel = row?.item_level == null ? "?" : row.item_level;
    const label = `${row?.name ?? `Item ${itemId}`} (i${itemLevel})`;
    const iconId = normalizeIconId(row?.icon_id);
    return {
      itemId,
      label,
      iconUrl: iconId > 0
        ? buildXivIconUrl(iconId, {
            useHqVariant: options?.gearUseHq === true && row?.can_be_hq === true,
          })
        : "",
    };
  });
  const selectedEntry =
    entries.find((entry) => entry.itemId === selectedId) ??
    entries[0] ??
    { itemId: selectedId, label: String(piece?.pieceName ?? "Unknown piece"), iconUrl: "" };
  const selectedIconHtml = selectedEntry.iconUrl
    ? `<img class="item-icon item-icon-slot" src="${selectedEntry.iconUrl}" alt="${escapeHtml(`${selectedEntry.label} icon`)}" loading="lazy" decoding="async">`
    : '<span class="item-icon item-icon-slot item-icon-placeholder" aria-hidden="true"></span>';
  const optionsHtml = rows
    .map((row, index) => {
      const entry = entries[index];
      const selectedClass = entry.itemId === selectedEntry.itemId ? " icon-dropdown-option-selected" : "";
      const iconHtml = entry.iconUrl
        ? `<img class="item-icon item-icon-slot" src="${IMAGE_PLACEHOLDER_SRC}" data-src="${entry.iconUrl}" alt="${escapeHtml(`${entry.label} icon`)}" loading="lazy" decoding="async">`
        : '<span class="item-icon item-icon-slot item-icon-placeholder" aria-hidden="true"></span>';
      return `
        <button
          type="button"
          class="icon-dropdown-option${selectedClass}"
          data-saved-plan-piece-gear-value="${entry.itemId}"
          title="${escapeHtml(entry.label)}"
        >
          <span class="item-with-icon">
            ${iconHtml}
            <span>${escapeHtml(entry.label)}</span>
          </span>
        </button>
      `;
    })
    .join("");

  return `
    <span>${escapeHtml(SLOT_DISPLAY[piece?.slot] ?? piece?.slot ?? "")} - </span>
    <div
      class="icon-dropdown saved-plan-piece-gear-dropdown"
      data-plan-id="${escapeHtml(options?.planId)}"
      data-piece-index="${pieceIndex}"
      tabindex="0"
    >
      <button type="button" class="icon-dropdown-trigger" data-saved-plan-piece-gear-trigger aria-haspopup="listbox" aria-expanded="false">
        <span class="item-with-icon">
          ${selectedIconHtml}
          <span class="icon-dropdown-trigger-label">${escapeHtml(selectedEntry.label)}</span>
        </span>
        <span class="icon-dropdown-caret" aria-hidden="true">&#9662;</span>
      </button>
      <div class="icon-dropdown-menu" role="listbox" aria-label="${escapeHtml(SLOT_DISPLAY[piece?.slot] ?? piece?.slot ?? "Gear")} options">
        ${optionsHtml}
      </div>
    </div>
  `;
}

function buildPieceLayout(piece, options = {}) {
  const slotKey = piece?.slot ?? "";
  const slot = escapeHtml(SLOT_DISPLAY[slotKey] ?? slotKey);
  const pieceNameRaw = String(piece?.pieceName ?? "Unknown piece");
  const pieceName = escapeHtml(pieceNameRaw);
  const pieceId = normalizeNonNegativeInteger(piece?.pieceId);
  const pieceIconId = resolveIconIdFromItemMap(options?.gearIconIdByItemId, pieceId);
  const pieceCanBeHq = resolveCanBeHqFromItemMap(options?.gearCanBeHqByItemId, pieceId);
  const pieceIconHtml = buildItemIconHtml(pieceIconId, pieceNameRaw, "item-icon item-icon-piece", {
    useHqVariant: options?.gearUseHq === true && pieceCanBeHq,
  });
  const pieceHeadIconHtml = options?.isEditing ? "" : pieceIconHtml;
  const melds = Array.isArray(piece?.melds) ? piece.melds : [];
  const pieceLayoutClass = "piece-layout";
  const pieceHeadContent = options?.isEditing
    ? buildSavedPlanPieceGearSelect(piece, options)
    : `<span>${slot} - ${pieceName}</span>`;
  const pieceStatTotal = buildPieceStatTotal(piece, options);

  if (melds.length === 0) {
    const maxMateriaSlots = Number(piece?.maxMateriaSlots) || 0;
    const noMeldReason =
      maxMateriaSlots <= 0
        ? "No materia slots on this piece"
        : "No melds assigned for this plan";
    return `
      <div class="${pieceLayoutClass}">
        <div class="piece-head item-with-icon">
          ${pieceHeadIconHtml}
          ${pieceHeadContent}
        </div>
        ${pieceStatTotal}
        <div class="muted">${escapeHtml(noMeldReason)}</div>
      </div>
    `;
  }

  const meldLines = melds
    .map((meld, meldIndex) => buildMeldLine(meld, { ...options, meldIndex }))
    .join("");
  // Refine diff: materia present in the baseline but dropped by this variant have
  // no candidate row to attach to, so render them as red "before"-only rows.
  const pieceIndex = normalizeNonNegativeInteger(options?.pieceIndex);
  const removedMeldsByPiece =
    options?.removedMeldsByPiece instanceof Map ? options.removedMeldsByPiece : null;
  const removedMelds =
    Boolean(options?.highlightDiff) && removedMeldsByPiece
      ? removedMeldsByPiece.get(pieceIndex) ?? []
      : [];
  const removedLines = removedMelds
    .map((meld) => buildMeldDisplayLine(meld, "meld-line-before", "−"))
    .join("");
  const pieceCapSummary = buildPieceCapSummary(piece);
  return `
    <div class="${pieceLayoutClass}">
      <div class="piece-head item-with-icon">
        ${pieceHeadIconHtml}
        ${pieceHeadContent}
      </div>
      ${pieceStatTotal}
      <ul class="meld-list">${meldLines}${removedLines}</ul>
      ${pieceCapSummary}
    </div>
  `;
}

function buildFoodPiece(food, options = {}) {
  const selectedFoodItemId = normalizeNonNegativeInteger(food?.itemId);
  const foodRows = Array.isArray(options?.foodRows) ? options.foodRows : [];
  const selectedFoodRow =
    foodRows.find((row) => normalizeNonNegativeInteger(row?.item_id) === selectedFoodItemId) ?? null;
  const sectionLabel = String(options?.sectionLabel ?? "Food");
  const quality = food?.useHq ? "HQ" : "NQ";
  const delta = food?.delta ?? {};
  const foodLabel = food ? `${food.name} [${quality}]` : "No food";
  const foodIconId =
    normalizeIconId(selectedFoodRow?.icon_id) ||
    resolveIconIdFromItemMap(options?.foodIconIdByItemId, selectedFoodItemId);
  const foodCanBeHq =
    selectedFoodRow?.can_be_hq === true ||
    resolveCanBeHqFromItemMap(options?.foodCanBeHqByItemId, selectedFoodItemId);
  const foodIconHtml = buildItemIconHtml(foodIconId, food?.name ?? "Food", "item-icon item-icon-food", {
    includePlaceholder: false,
    useHqVariant: Boolean(food?.useHq) && foodCanBeHq,
  });

  if (options?.isEditing) {
    return `
      <div class="piece-layout">
        <div class="piece-head">${escapeHtml(sectionLabel)}</div>
        <ul class="meld-list">
          <li class="meld-line meld-line-editable">
            <span class="saved-plan-inline-slot muted">Meal</span>
            <select data-action="saved-plan-edit-food" data-plan-id="${escapeHtml(options?.planId)}">
              ${buildFoodOptionsHtml(foodRows, selectedFoodItemId)}
            </select>
          </li>
          <li class="meld-line">
            <label class="checkbox-row saved-plan-food-quality-row">
              <input
                type="checkbox"
                data-action="saved-plan-edit-food-hq"
                data-plan-id="${escapeHtml(options?.planId)}"
                ${food?.useHq ? "checked" : ""}
                ${selectedFoodItemId > 0 && selectedFoodRow?.can_be_hq ? "" : "disabled"}
              >
              <span>Use HQ</span>
            </label>
          </li>
          <li class="meld-line muted">+G${normalizeNonNegativeInteger(delta.gathering)} +P${normalizeNonNegativeInteger(delta.perception)} +GP${normalizeNonNegativeInteger(delta.gp)}</li>
        </ul>
      </div>
    `;
  }

  return `
    <div class="piece-layout">
      <div class="piece-head">${escapeHtml(sectionLabel)}</div>
      <ul class="meld-list">
        <li class="meld-line">
          <span class="item-with-icon">
            ${foodIconHtml}
            <span>${escapeHtml(foodLabel)}</span>
          </span>
        </li>
        <li class="meld-line muted">+G${normalizeNonNegativeInteger(delta.gathering)} +P${normalizeNonNegativeInteger(delta.perception)} +GP${normalizeNonNegativeInteger(delta.gp)}</li>
      </ul>
    </div>
  `;
}

function buildFoodPiecesForPlan(food, options = {}) {
  if (options?.isEditing) {
    return buildFoodPiece(food, options);
  }

  const advancedProfiles = Array.isArray(options?.advancedProfiles) ? options.advancedProfiles : [];
  if (advancedProfiles.length === 0) {
    return buildFoodPiece(food, options);
  }

  return advancedProfiles
    .map((profile, index) => {
      const profileLabel = String(profile?.profileName ?? `Profile ${index + 1}`);
      return buildFoodPiece(profile?.food ?? null, {
        ...options,
        sectionLabel: `Food - ${profileLabel}`,
      });
    })
    .join("");
}

function buildPlanLayoutHtml(plan, food, options = {}) {
  const pieceMelds = Array.isArray(plan?.pieceMelds) ? plan.pieceMelds : [];
  const bySlot = new Map();
  pieceMelds.forEach((piece, pieceIndex) => {
    const slot = piece?.slot ?? "__unknown__";
    if (!bySlot.has(slot)) {
      bySlot.set(slot, []);
    }
    bySlot.get(slot).push({
      piece,
      pieceIndex,
    });
  });

  const leftHtml = LEFT_SLOT_ORDER
    .flatMap((slot) => bySlot.get(slot) ?? [])
    .map(({ piece, pieceIndex }) => buildPieceLayout(piece, { ...options, pieceIndex }))
    .join("");

  const rightHtml = [...bySlot.entries()]
    .filter(([slot]) => !LEFT_SLOT_SET.has(slot))
    .flatMap(([, pieces]) => pieces)
    .map(({ piece, pieceIndex }) => buildPieceLayout(piece, { ...options, pieceIndex }))
    .join("") + buildFoodPiecesForPlan(food, options);

  return `
    <div class="plan-layout">
      <div class="plan-col">${leftHtml}</div>
      <div class="plan-col">${rightHtml}</div>
    </div>
  `;
}

function formatSavedAt(savedAt) {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) {
    return escapeHtml(String(savedAt ?? ""));
  }
  return escapeHtml(date.toLocaleString());
}

function gradeValueByStatAndGrade(statKey, grade, gradeValueIndexByStat, fallbackValue = 0) {
  const statIndex = gradeValueIndexByStat?.[statKey];
  if (statIndex && typeof statIndex.get === "function") {
    return normalizeNonNegativeInteger(statIndex.get(Number(grade)), normalizeNonNegativeInteger(fallbackValue));
  }
  return normalizeNonNegativeInteger(fallbackValue);
}

function buildGradeOptionsHtml(grades, selectedGrade, statKey, gradeValueIndexByStat, fallbackValue = 0) {
  const rows = Array.isArray(grades) && grades.length > 0 ? grades : [1];
  return rows
    .map((grade) => {
      const selected = Number(grade) === Number(selectedGrade) ? " selected" : "";
      const amount = gradeValueByStatAndGrade(statKey, grade, gradeValueIndexByStat, fallbackValue);
      return `<option value="${Number(grade)}"${selected}>+${amount} (${escapeHtml(gradeToRoman(Number(grade)))})</option>`;
    })
    .join("");
}

function buildStatOptionsHtml(selectedStat) {
  return STAT_KEYS.map((statKey) => {
    const selected = statKey === selectedStat ? " selected" : "";
    return `<option value="${statKey}"${selected}>${escapeHtml(STAT_DISPLAY[statKey])}</option>`;
  }).join("");
}

function buildFoodOptionsHtml(foodRows, selectedFoodItemId) {
  const rows = Array.isArray(foodRows) ? foodRows : [];
  const selectedId = normalizeNonNegativeInteger(selectedFoodItemId, 0);
  const baseOption = `<option value="0"${selectedId === 0 ? " selected" : ""}>No food</option>`;
  const rowOptions = rows
    .map((row) => {
      const itemId = normalizeNonNegativeInteger(row?.item_id, 0);
      const selected = itemId === selectedId ? " selected" : "";
      return `<option value="${itemId}"${selected}>${escapeHtml(row?.name ?? `Food ${itemId}`)}</option>`;
    })
    .join("");
  return `${baseOption}${rowOptions}`;
}

function buildAdjustmentDiffHtml(adjustmentDiff) {
  const count = normalizeNonNegativeInteger(adjustmentDiff?.count);
  const lines = Array.isArray(adjustmentDiff?.lines) ? adjustmentDiff.lines : [];
  if (count <= 0) {
    return '<p class="muted adjustment-summary">Changes from baseline: none.</p>';
  }

  const renderedLines = lines
    .slice(0, 24)
    .map((line) => `<li>${escapeHtml(String(line ?? ""))}</li>`)
    .join("");
  const hiddenCount = Math.max(0, lines.length - 24);
  const hiddenNote = hiddenCount > 0 ? `<li class="muted">...and ${hiddenCount} more changes.</li>` : "";
  return `
    <div class="adjustment-diff">
      <p class="adjustment-summary"><strong>Changes from baseline:</strong> ${count}</p>
      <ul class="adjustment-list">
        ${renderedLines}
        ${hiddenNote}
      </ul>
    </div>
  `;
}

function buildSavedPlanBreakpointCheckViewer(savedPlanId, state) {
  const preview = state?.savedPlansUi?.breakpointCheckPreviewByPlanId?.[savedPlanId];
  const profiles = Array.isArray(preview?.profiles) ? preview.profiles : [];
  const baseTotals = {
    gathering: normalizeNonNegativeInteger(preview?.baseTotals?.gathering),
    perception: normalizeNonNegativeInteger(preview?.baseTotals?.perception),
    gp: normalizeNonNegativeInteger(preview?.baseTotals?.gp),
  };
  const totalMet = normalizeNonNegativeInteger(preview?.breakpointsMet);
  const totalEnabled = normalizeNonNegativeInteger(preview?.breakpointsEnabled);
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  const foodDraftByProfileId = state?.savedPlansUi?.breakpointCheckFoodByPlanId?.[savedPlanId] ?? {};

  const profileRowsHtml =
    profiles.length === 0
      ? '<p class="muted">No enabled advanced profiles to score.</p>'
      : profiles
          .map((profile, index) => {
            const profileId = String(profile?.profileId ?? "");
            const selectedDraft = foodDraftByProfileId?.[profileId] ?? {};
            const selectedFoodItemId = normalizeNonNegativeInteger(
              selectedDraft?.foodItemId,
              normalizeNonNegativeInteger(profile?.food?.itemId),
            );
            const selectedFoodRow =
              foodRows.find((row) => normalizeNonNegativeInteger(row?.item_id) === selectedFoodItemId) ?? null;
            const useHq = Boolean(selectedDraft?.useHq ?? profile?.food?.useHq);
            const hqEnabled = selectedFoodItemId > 0 && selectedFoodRow?.can_be_hq;
            return `
              <div class="saved-plan-breakpoint-branch">
                <div class="saved-plan-breakpoint-controls">
                  <label>
                    <span class="muted">Branch Food - ${escapeHtml(String(profile?.profileName ?? `Profile ${index + 1}`))}</span>
                    <select
                      data-action="saved-plan-breakpoint-food"
                      data-plan-id="${escapeHtml(savedPlanId)}"
                      data-profile-id="${escapeHtml(profileId)}"
                    >
                      ${buildFoodOptionsHtml(foodRows, selectedFoodItemId)}
                    </select>
                  </label>
                  <label class="checkbox-row">
                    <input
                      type="checkbox"
                      data-action="saved-plan-breakpoint-food-hq"
                      data-plan-id="${escapeHtml(savedPlanId)}"
                      data-profile-id="${escapeHtml(profileId)}"
                      ${hqEnabled && useHq ? "checked" : ""}
                      ${hqEnabled ? "" : "disabled"}
                    >
                    <span>HQ</span>
                  </label>
                </div>
                ${buildAdvancedProfileSummary(profile)}
              </div>
            `;
          })
          .join("");

  return `
    <div class="saved-plan-breakpoint-check">
      <p class="muted">Breakpoint Check: ${totalMet}/${totalEnabled} | Base (No Food) G ${baseTotals.gathering} P ${baseTotals.perception} GP ${baseTotals.gp}</p>
      ${profileRowsHtml}
    </div>
  `;
}

function buildSavedPlanRefinePanel(savedPlanId, state, baselineTotals) {
  const dialog = state?.savedPlansUi?.refineDialog;
  if (!dialog || String(dialog?.planId ?? "") !== savedPlanId) {
    return "";
  }

  const objective = dialog?.objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS
    ? REFINE_OBJECTIVES.HIT_NEW_TARGETS
    : REFINE_OBJECTIVES.IMPROVE_SCORE;
  const advancedEnabled = state?.advanced?.enabled === true;
  const showTargetInputs = objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS && !advancedEnabled;
  const targets = {
    gathering: normalizeNonNegativeInteger(dialog?.targets?.gathering, baselineTotals.gathering),
    perception: normalizeNonNegativeInteger(dialog?.targets?.perception, baselineTotals.perception),
    gp: normalizeNonNegativeInteger(dialog?.targets?.gp, baselineTotals.gp),
  };
  const improveChecked = objective === REFINE_OBJECTIVES.IMPROVE_SCORE ? "checked" : "";
  const targetsChecked = objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS ? "checked" : "";
  const objectiveNote = objective === REFINE_OBJECTIVES.HIT_NEW_TARGETS && advancedEnabled
    ? '<p class="muted">Advanced refine uses the enabled breakpoint profiles as targets.</p>'
    : "";
  const targetInputsHtml = showTargetInputs
    ? `
      <div class="saved-plan-refine-targets">
        ${STAT_KEYS.map((statKey) => `
          <label>
            <span>${STAT_DISPLAY[statKey]}</span>
            <input
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              data-action="saved-plan-refine-target"
              data-plan-id="${escapeHtml(savedPlanId)}"
              data-refine-target="${escapeHtml(statKey)}"
              value="${escapeHtml(targets[statKey])}"
            >
          </label>
        `).join("")}
      </div>
    `
    : "";

  return `
    <div class="saved-plan-refine-panel">
      <h5>Refine Plan</h5>
      <p class="muted">Choose how refined results should be filtered and ranked.</p>
      <div class="saved-plan-refine-options">
        <label class="checkbox-row">
          <input
            type="radio"
            name="saved-plan-refine-objective-${escapeHtml(savedPlanId)}"
            data-action="saved-plan-refine-objective"
            data-plan-id="${escapeHtml(savedPlanId)}"
            value="${REFINE_OBJECTIVES.IMPROVE_SCORE}"
            ${improveChecked}
          >
          <span>Improve current plan score</span>
        </label>
        <label class="checkbox-row">
          <input
            type="radio"
            name="saved-plan-refine-objective-${escapeHtml(savedPlanId)}"
            data-action="saved-plan-refine-objective"
            data-plan-id="${escapeHtml(savedPlanId)}"
            value="${REFINE_OBJECTIVES.HIT_NEW_TARGETS}"
            ${targetsChecked}
          >
          <span>Hit new targets</span>
        </label>
      </div>
      ${objectiveNote}
      ${targetInputsHtml}
      <div class="saved-plan-refine-actions">
        <button type="button" data-action="saved-plan-refine-submit" data-plan-id="${escapeHtml(savedPlanId)}">Run Refine</button>
        <button type="button" data-action="saved-plan-refine-cancel" data-plan-id="${escapeHtml(savedPlanId)}">Cancel</button>
      </div>
    </div>
  `;
}

function buildSavedPlanCardHtml(savedPlan, state, iconContext = {}) {
  const savedPlanId = String(savedPlan?.id ?? "");
  const isViewing = state?.savedPlansUi?.viewPlanId === savedPlanId;
  const isEditing = state?.savedPlansUi?.editingPlanId === savedPlanId;
  const advancedEnabled = state?.advanced?.enabled === true;
  const isCheckingBreakpoints = state?.savedPlansUi?.breakpointCheckViewPlanId === savedPlanId;
  const previewPlan = state?.savedPlansUi?.previewByPlanId?.[savedPlanId] ?? savedPlan;
  const totals = {
    gathering: normalizeNonNegativeInteger(previewPlan?.totalGathering),
    perception: normalizeNonNegativeInteger(previewPlan?.totalPerception),
    gp: normalizeNonNegativeInteger(previewPlan?.totalGp),
  };
  const targetCaps = {
    gathering: normalizeNonNegativeInteger(state?.targets?.gathering),
    perception: normalizeNonNegativeInteger(state?.targets?.perception),
    gp: normalizeNonNegativeInteger(state?.targets?.gp),
  };
  const gearRows = Array.isArray(state?.data?.gear?.rows) ? state.data.gear.rows : [];
  const foodRows = Array.isArray(state?.data?.food?.rows) ? state.data.food.rows : [];
  const quality = previewPlan?.food?.useHq ? "HQ" : "NQ";
  const foodText = previewPlan?.food
    ? `${previewPlan.food.name} [${quality}]`
    : "No food";
  const previewFoodItemId = normalizeNonNegativeInteger(previewPlan?.food?.itemId);
  const previewFoodRow =
    foodRows.find((row) => normalizeNonNegativeInteger(row?.item_id) === previewFoodItemId) ?? null;
  const previewFoodCanBeHq = previewFoodRow?.can_be_hq === true;
  const previewFoodIconHtml = buildItemIconHtml(
    normalizeIconId(previewFoodRow?.icon_id),
    previewPlan?.food?.name ?? "Food",
    "item-icon item-icon-food",
    {
      includePlaceholder: false,
      useHqVariant: Boolean(previewPlan?.food?.useHq) && previewFoodCanBeHq,
    },
  );

  const actionBar = `
    <div class="saved-plan-actions">
      <button type="button" data-action="saved-plan-view" data-plan-id="${escapeHtml(savedPlanId)}" ${isEditing ? "disabled" : ""}>${isViewing ? "Hide" : "View"}</button>
      <button type="button" data-action="saved-plan-edit" data-plan-id="${escapeHtml(savedPlanId)}">${isEditing ? "Stop Editing" : "Edit"}</button>
      <button type="button" data-action="saved-plan-copy" data-plan-id="${escapeHtml(savedPlanId)}" ${isEditing ? "disabled" : ""}>Copy</button>
      <button type="button" data-action="saved-plan-refine" data-plan-id="${escapeHtml(savedPlanId)}" ${isEditing ? "disabled" : ""}>Refine</button>
      ${
        advancedEnabled
          ? `<button type="button" data-action="saved-plan-check-breakpoints" data-plan-id="${escapeHtml(savedPlanId)}">${isCheckingBreakpoints ? "Hide Breakpoints" : "Check Breakpoints"}</button>`
          : ""
      }
      ${isEditing ? `<button type="button" data-action="saved-plan-save-edits" data-plan-id="${escapeHtml(savedPlanId)}">Save Edits</button>` : ""}
      ${isEditing ? `<button type="button" data-action="saved-plan-cancel-edits" data-plan-id="${escapeHtml(savedPlanId)}">Cancel</button>` : ""}
      <button type="button" data-action="saved-plan-export" data-plan-id="${escapeHtml(savedPlanId)}">Export Text</button>
      <button type="button" data-action="saved-plan-delete" data-plan-id="${escapeHtml(savedPlanId)}">Delete</button>
    </div>
  `;

  const breakpointCheckHtml =
    advancedEnabled && isCheckingBreakpoints ? buildSavedPlanBreakpointCheckViewer(savedPlanId, state) : "";
  const refinePanelHtml = buildSavedPlanRefinePanel(savedPlanId, state, totals);

  const viewHtml = isViewing
    ? `
      <div class="saved-plan-view">
        ${isEditing ? '<p class="muted">Editing meld slots inline. Changes are revalidated against per-piece caps before saving.</p>' : ""}
        ${buildPlanLayoutHtml(previewPlan, previewPlan.food, {
          isEditing,
          planId: savedPlanId,
          availableGradesByStat: state?.savedPlansUi?.availableGradesByStat,
          overmeldAllowedGradesByStat: state?.savedPlansUi?.overmeldAllowedGradesByStat,
          gradeValueIndexByStat: state?.savedPlansUi?.gradeValueIndexByStat,
          gearRows,
          foodRows,
          gearIconIdByItemId: iconContext?.gearIconIdByItemId,
          foodIconIdByItemId: iconContext?.foodIconIdByItemId,
          gearCanBeHqByItemId: iconContext?.gearCanBeHqByItemId,
          foodCanBeHqByItemId: iconContext?.foodCanBeHqByItemId,
          gearUseHq: iconContext?.gearUseHq === true,
        })}
      </div>
    `
    : "";

  return `
    <div class="saved-plan-card">
      <div class="saved-plan-header">
        <div>
          ${
            isEditing
              ? `<input
                class="saved-plan-name-inline-input"
                type="text"
                data-action="saved-plan-edit-name"
                data-plan-id="${escapeHtml(savedPlanId)}"
                value="${escapeHtml(previewPlan?.name ?? savedPlan?.name ?? "")}"
                maxlength="120"
              />`
              : `<h4>${escapeHtml(savedPlan?.name ?? "Saved plan")}</h4>`
          }
          <p class="muted">Saved ${formatSavedAt(savedPlan?.savedAt)}</p>
        </div>
        <div class="saved-plan-totals">
          <span><strong>G</strong> ${formatTotalVsCap(totals.gathering, targetCaps.gathering)}</span>
          <span><strong>P</strong> ${formatTotalVsCap(totals.perception, targetCaps.perception)}</span>
          <span><strong>GP</strong> ${formatTotalVsCap(totals.gp, targetCaps.gp)}</span>
        </div>
      </div>
      <p class="muted item-with-icon">Food: ${previewFoodIconHtml}<span>${escapeHtml(foodText)}</span></p>
      ${actionBar}
      ${refinePanelHtml}
      ${breakpointCheckHtml}
      ${viewHtml}
    </div>
  `;
}

function buildSavedPlansPanelHtml(state) {
  const savedPlans = Array.isArray(state?.savedPlans) ? state.savedPlans : [];
  const iconContext = buildRenderIconContext(state);
  const cardsHtml = savedPlans.length === 0
    ? '<p class="muted">No saved plans yet.</p>'
    : savedPlans.map((plan) => buildSavedPlanCardHtml(plan, state, iconContext)).join("");

  return `
    <section class="saved-plans-section" aria-label="Saved plans">
      <h3>Saved Plans (${savedPlans.length})</h3>
      ${cardsHtml}
    </section>
  `;
}

function normalizeAdvancedStatDump(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ADVANCED_STAT_DUMP_OPTIONS, raw)) {
    return raw;
  }
  return "none";
}

function statDumpLabel(statDump) {
  const mode = normalizeAdvancedStatDump(statDump);
  return ADVANCED_STAT_DUMP_OPTIONS[mode] ?? ADVANCED_STAT_DUMP_OPTIONS.none;
}

function variantFoodLabel(food) {
  const itemId = normalizeNonNegativeInteger(food?.itemId);
  if (itemId <= 0) {
    return "No food";
  }
  const name = String(food?.name ?? `Food ${itemId}`);
  const quality = food?.useHq ? "HQ" : "NQ";
  return `${name} [${quality}]`;
}

function variantTotalsLabel(plan, row) {
  const totals = {
    gathering: normalizeNonNegativeInteger(plan?.totalGathering ?? row?.totalGathering),
    perception: normalizeNonNegativeInteger(plan?.totalPerception ?? row?.totalPerception),
    gp: normalizeNonNegativeInteger(plan?.totalGp ?? row?.totalGp),
  };
  return `G ${totals.gathering} / P ${totals.perception} / GP ${totals.gp}`;
}

function buildPlansRows(row, resultIndex, state, iconContext = {}) {
  const plans = Array.isArray(row?.plans) ? row.plans : [];
  if (plans.length === 0) {
    return '<span class="muted">No piece-level meld data.</span>';
  }

  return plans.map((plan, planIndex) => {
    const planDiffKey = `${resultIndex}:${planIndex}`;
    const diffEnabled = Boolean(state?.resultsUi?.diffEnabledByPlanKey?.[planDiffKey]);
    // Map each changed candidate meld back to the baseline meld it replaced, so a
    // changed row can render the old materia (red) above the new one (green).
    // Removals (no candidate meld) are grouped per piece and appended as red-only
    // rows by buildPieceLayout.
    const changes = Array.isArray(plan?.adjustmentDiff?.changes) ? plan.adjustmentDiff.changes : [];
    const meldChangeByKey = new Map();
    const removedMeldsByPiece = new Map();
    for (const change of changes) {
      const pieceIndex = normalizeNonNegativeInteger(change?.pieceIndex);
      const slotIndex = normalizeNonNegativeInteger(change?.slotIndex);
      if (change?.after) {
        meldChangeByKey.set(`${pieceIndex}:${slotIndex}`, change);
      } else if (change?.before) {
        const list = removedMeldsByPiece.get(pieceIndex) ?? [];
        list.push(change.before);
        removedMeldsByPiece.set(pieceIndex, list);
      }
    }
    const canToggleDiff = Boolean(plan?.adjustmentDiff);
    const detailsOpen =
      diffEnabled || Boolean(state?.resultsUi?.openPlanDetailsByPlanKey?.[planDiffKey]);
    const label = `Variant ${planIndex + 1} (${variantTotalsLabel(plan, row)} | ${variantFoodLabel(plan?.food ?? row?.food)})`;
    const diffButton = canToggleDiff
      ? `<button type="button" data-action="result-plan-toggle-diff" data-result-index="${resultIndex}" data-plan-index="${planIndex}">${diffEnabled ? "Hide Before/After" : "Show Before/After"}</button>`
      : "";
    const diffSection = canToggleDiff
      ? (diffEnabled
        ? buildAdjustmentDiffHtml(plan?.adjustmentDiff)
        : '<p class="muted adjustment-summary">Before/after hidden. Show it to compare against your current melds.</p>')
      : buildAdjustmentDiffHtml(plan?.adjustmentDiff);
    return `
      <details
        class="plan-details"
        data-result-index="${resultIndex}"
        data-plan-index="${planIndex}"
        ${detailsOpen ? "open" : ""}
      >
        <summary>${label}</summary>
        <div class="plan-variant-actions">
          <button type="button" data-action="result-plan-save" data-result-index="${resultIndex}" data-plan-index="${planIndex}">Save Plan</button>
          ${diffButton}
        </div>
        ${diffSection}
        ${buildPlanLayoutHtml(plan, plan?.food ?? row.food, {
          highlightDiff: diffEnabled,
          meldChangeByKey,
          removedMeldsByPiece,
          advancedProfiles: Array.isArray(plan?.advanced?.profiles) ? plan.advanced.profiles : [],
          gearIconIdByItemId: iconContext?.gearIconIdByItemId,
          foodIconIdByItemId: iconContext?.foodIconIdByItemId,
          gearCanBeHqByItemId: iconContext?.gearCanBeHqByItemId,
          foodCanBeHqByItemId: iconContext?.foodCanBeHqByItemId,
          gearUseHq: iconContext?.gearUseHq === true,
        })}
      </details>
    `;
  }).join("");
}

function closeSavedPlanGearDropdowns(resultsPanelElement) {
  resultsPanelElement.querySelectorAll(".saved-plan-piece-gear-dropdown").forEach((dropdown) => {
    dropdown.classList.remove("open");
    const trigger = dropdown.querySelector("[data-saved-plan-piece-gear-trigger]");
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
    }
  });
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
  Array.from(menu.querySelectorAll("img[data-src]"))
    .slice(0, Math.max(0, Number(limit) || 0))
    .forEach((img) => loadPendingDropdownImage(img));
}

function ensureDropdownLazyImageLoading(dropdown) {
  const menu = dropdown.querySelector(".icon-dropdown-menu");
  if (!menu) {
    return;
  }

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
    pendingImages.forEach((img) => dropdown.__iconLazyObserver.observe(img));
    return;
  }

  pendingImages.slice(0, 20).forEach((img) => loadPendingDropdownImage(img));
}

function wireSavedPlanGearDropdowns(resultsPanelElement, handlers) {
  resultsPanelElement.querySelectorAll(".saved-plan-piece-gear-dropdown").forEach((dropdown) => {
    const trigger = dropdown.querySelector("[data-saved-plan-piece-gear-trigger]");
    if (trigger) {
      trigger.addEventListener("click", () => {
        const wasOpen = dropdown.classList.contains("open");
        closeSavedPlanGearDropdowns(resultsPanelElement);
        if (!wasOpen) {
          dropdown.classList.add("open");
          trigger.setAttribute("aria-expanded", "true");
          ensureDropdownLazyImageLoading(dropdown);
        }
      });
    }

    dropdown.addEventListener("focusout", (event) => {
      const nextFocused = event.relatedTarget;
      if (!nextFocused || !dropdown.contains(nextFocused)) {
        dropdown.classList.remove("open");
        if (trigger) {
          trigger.setAttribute("aria-expanded", "false");
        }
      }
    });

    dropdown.querySelectorAll("[data-saved-plan-piece-gear-value]").forEach((optionButton) => {
      optionButton.addEventListener("click", (event) => {
        dropdown.classList.remove("open");
        if (trigger) {
          trigger.setAttribute("aria-expanded", "false");
        }
        handlers?.onSavedPlanDraftChange?.({
          planId: dropdown.getAttribute("data-plan-id"),
          pieceIndex: normalizeNonNegativeInteger(dropdown.getAttribute("data-piece-index")),
          meldIndex: 0,
          field: "pieceId",
          value: event.currentTarget.getAttribute("data-saved-plan-piece-gear-value"),
        });
      });
    });
  });
}

function wireEvents(resultsPanelElement, handlers) {
  const callbackByAction = {
    "result-plan-save": handlers?.onSaveResultPlan,
    "result-plan-toggle-diff": handlers?.onToggleResultPlanDiff,
    "saved-plan-view": handlers?.onToggleSavedPlanView,
    "saved-plan-edit": handlers?.onToggleSavedPlanEdit,
    "saved-plan-copy": handlers?.onCopySavedPlan,
    "saved-plan-delete": handlers?.onDeleteSavedPlan,
    "saved-plan-export": handlers?.onExportSavedPlan,
    "saved-plan-refine": handlers?.onRefineSavedPlan,
    "saved-plan-refine-submit": handlers?.onSubmitSavedPlanRefine,
    "saved-plan-refine-cancel": handlers?.onCancelSavedPlanRefine,
    "saved-plan-check-breakpoints": handlers?.onToggleSavedPlanBreakpointCheck,
    "saved-plan-save-edits": handlers?.onSaveSavedPlanEdits,
    "saved-plan-cancel-edits": handlers?.onCancelSavedPlanEdits,
    "advanced-profile-add": handlers?.onAdvancedAddProfile,
    "advanced-profile-copy": handlers?.onAdvancedCopyProfile,
    "advanced-preset-load-75": handlers?.onAdvancedLoadPreset75,
    "advanced-profile-tab": handlers?.onAdvancedProfileTabChange,
    "advanced-profile-remove": handlers?.onAdvancedRemoveProfile,
    "advanced-breakpoint-add": handlers?.onAdvancedAddBreakpoint,
    "advanced-breakpoint-remove": handlers?.onAdvancedRemoveBreakpoint,
  };

  resultsPanelElement.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const action = event.currentTarget.getAttribute("data-action");
      const profileIndex = normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index"));

      if (action === "advanced-food-remove") {
        const foodId = normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-food-id"));
        handlers?.onAdvancedFoodToggle?.({ profileIndex, foodId, enabled: false });
        return;
      }

      const handler = callbackByAction[action];
      if (typeof handler !== "function") {
        return;
      }
      const payload = {
        planId: event.currentTarget.getAttribute("data-plan-id"),
        resultIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-result-index")),
        planIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-plan-index")),
        profileIndex,
        profileId: event.currentTarget.getAttribute("data-profile-id"),
        breakpointId: event.currentTarget.getAttribute("data-breakpoint-id"),
      };
      if (action === "advanced-profile-tab") {
        handler(payload.profileIndex);
        return;
      }
      handler(payload);
    });
  });

  resultsPanelElement.querySelectorAll("details.plan-details").forEach((details) => {
    details.addEventListener("toggle", (event) => {
      handlers?.onResultPlanDetailsToggle?.({
        resultIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-result-index")),
        planIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-plan-index")),
        open: Boolean(event.currentTarget.open),
      });
    });
  });

  wireSavedPlanGearDropdowns(resultsPanelElement, handlers);

  resultsPanelElement.querySelectorAll("select[data-action]").forEach((select) => {
    select.addEventListener("change", (event) => {
      const action = event.currentTarget.getAttribute("data-action");

      if (action === "advanced-food-add") {
        const profileIndex = normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index"));
        const foodId = normalizeNonNegativeInteger(event.currentTarget.value);
        if (foodId > 0) {
          handlers?.onAdvancedFoodToggle?.({ profileIndex, foodId, enabled: true });
        }
        event.currentTarget.value = "0";
        return;
      }

      if (action === "saved-plan-breakpoint-food") {
        if (typeof handlers?.onSavedPlanBreakpointCheckChange !== "function") {
          return;
        }
        handlers.onSavedPlanBreakpointCheckChange({
          planId: event.currentTarget.getAttribute("data-plan-id"),
          profileId: event.currentTarget.getAttribute("data-profile-id"),
          field: "foodItemId",
          value: event.currentTarget.value,
        });
        return;
      }

      if (action === "saved-plan-edit-food") {
        if (typeof handlers?.onSavedPlanDraftChange !== "function") {
          return;
        }
        handlers.onSavedPlanDraftChange({
          planId: event.currentTarget.getAttribute("data-plan-id"),
          pieceIndex: 0,
          meldIndex: 0,
          field: "foodItemId",
          value: event.currentTarget.value,
        });
        return;
      }
      if (action === "saved-plan-edit-piece") {
        if (typeof handlers?.onSavedPlanDraftChange !== "function") {
          return;
        }
        handlers.onSavedPlanDraftChange({
          planId: event.currentTarget.getAttribute("data-plan-id"),
          pieceIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-piece-index")),
          meldIndex: 0,
          field: "pieceId",
          value: event.currentTarget.value,
        });
        return;
      }
      if (action !== "saved-plan-edit-stat" && action !== "saved-plan-edit-grade") {
        return;
      }
      if (typeof handlers?.onSavedPlanDraftChange !== "function") {
        return;
      }
      handlers.onSavedPlanDraftChange({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        pieceIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-piece-index")),
        meldIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-meld-index")),
        field: action === "saved-plan-edit-stat" ? "stat" : "grade",
        value: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="saved-plan-edit-name"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      if (typeof handlers?.onSavedPlanDraftChange !== "function") {
        return;
      }
      handlers.onSavedPlanDraftChange({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        pieceIndex: 0,
        meldIndex: 0,
        field: "name",
        value: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="saved-plan-edit-food-hq"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      if (typeof handlers?.onSavedPlanDraftChange !== "function") {
        return;
      }
      handlers.onSavedPlanDraftChange({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        pieceIndex: 0,
        meldIndex: 0,
        field: "foodUseHq",
        value: Boolean(event.currentTarget.checked),
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="saved-plan-refine-objective"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      if (!event.currentTarget.checked) {
        return;
      }
      handlers?.onSavedPlanRefineDraftChange?.({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        field: "objective",
        value: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="saved-plan-refine-target"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      handlers?.onSavedPlanRefineDraftChange?.({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        field: event.currentTarget.getAttribute("data-refine-target"),
        value: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="saved-plan-breakpoint-food-hq"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      if (typeof handlers?.onSavedPlanBreakpointCheckChange !== "function") {
        return;
      }
      handlers.onSavedPlanBreakpointCheckChange({
        planId: event.currentTarget.getAttribute("data-plan-id"),
        profileId: event.currentTarget.getAttribute("data-profile-id"),
        field: "useHq",
        value: Boolean(event.currentTarget.checked),
      });
    });
  });

  resultsPanelElement.querySelectorAll("input[data-advanced-toggle-enabled]").forEach((input) => {
    input.addEventListener("change", (event) => {
      handlers?.onAdvancedEnabledChange?.(Boolean(event.currentTarget.checked));
    });
  });

  resultsPanelElement.querySelectorAll("input[data-advanced-profile-name]").forEach((input) => {
    input.addEventListener("change", (event) => {
      handlers?.onAdvancedProfileNameChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        value: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll('input[data-action="advanced-profile-enabled"]').forEach((input) => {
    input.addEventListener("change", (event) => {
      handlers?.onAdvancedProfileEnabledChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        enabled: Boolean(event.currentTarget.checked),
      });
    });
  });

  resultsPanelElement.querySelectorAll("input[data-advanced-profile-hq]").forEach((input) => {
    input.addEventListener("change", (event) => {
      handlers?.onAdvancedProfileFoodQualityChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        useHq: Boolean(event.currentTarget.checked),
      });
    });
  });

  resultsPanelElement.querySelectorAll("select[data-advanced-profile-stat-dump]").forEach((select) => {
    select.addEventListener("change", (event) => {
      handlers?.onAdvancedProfileStatDumpChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        statDump: event.currentTarget.value,
      });
    });
  });

  resultsPanelElement.querySelectorAll("input[data-advanced-breakpoint-enabled]").forEach((input) => {
    input.addEventListener("change", (event) => {
      handlers?.onAdvancedBreakpointFieldChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        breakpointId: event.currentTarget.getAttribute("data-breakpoint-id"),
        field: "enabled",
        value: Boolean(event.currentTarget.checked),
      });
    });
  });

  resultsPanelElement.querySelectorAll("input[data-advanced-breakpoint-field], select[data-advanced-breakpoint-field]").forEach((el) => {
    el.addEventListener("change", (event) => {
      handlers?.onAdvancedBreakpointFieldChange?.({
        profileIndex: normalizeNonNegativeInteger(event.currentTarget.getAttribute("data-profile-index")),
        breakpointId: event.currentTarget.getAttribute("data-breakpoint-id"),
        field: event.currentTarget.getAttribute("data-advanced-breakpoint-field"),
        value: event.currentTarget.value,
      });
    });
  });
}

export function renderResultsTable(resultsPanelElement, state, handlers = {}) {
  const rows = Array.isArray(state.results) ? state.results : [];
  const targets = state?.targets ?? {};
  const targetsActive = hasAnyTargets(targets);
  const advancedEnabled = state?.advanced?.enabled === true;
  const iconContext = buildRenderIconContext(state);

  const bodyHtml =
    rows.length === 0
      ? '<tbody><tr><td colspan="3" class="muted">No legal plans generated.</td></tr></tbody>'
      : rows
          .slice(0, state.solve.maxResults)
          .map((row, index) => `
            <tbody>
              <tr>
                <td>${index + 1}</td>
                <td>${
                  advancedEnabled
                    ? `${normalizeNonNegativeInteger(row?.advanced?.breakpointsMet)}/${normalizeNonNegativeInteger(row?.advanced?.breakpointsEnabled)}`
                    : Math.round(row?.score ?? 0)
                }</td>
                <td>
                  ${
	                  advancedEnabled
	                    ? buildAdvancedCell(row)
	                    : `
	                        <div class="plan-hit ${
                            !targetsActive ? "muted" : row?.meetsTargets ? "hit" : "miss"
                          }">
	                          ${
                              !targetsActive
                                ? "No Target Set"
                                : row?.meetsTargets
                                  ? "Meets Target"
                                  : "Below Target"
                            }
	                        </div>
	                        ${buildTotalsCell(row, targets)}
	                      `
	                  }
                </td>
              </tr>
              <tr class="plans-row">
                <td colspan="3">${buildPlansRows(row, index, state, iconContext)}</td>
              </tr>
            </tbody>
          `)
          .join("");

  resultsPanelElement.innerHTML = `
    <h2>Results</h2>
    <p class="muted">${
      advancedEnabled
        ? "Breakpoint-focused ranking with per-profile food outcomes and hit/miss summaries."
        : "Plan totals and per-piece meld layouts."
    }</p>
    ${buildAdvancedConfigPanel(state)}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>${advancedEnabled ? "Breakpoints" : "Score"}</th>
            <th>${advancedEnabled ? "Advanced Summary" : "Totals"}</th>
          </tr>
        </thead>
        ${bodyHtml}
      </table>
    </div>
    ${buildSavedPlansPanelHtml(state)}
  `;

  wireEvents(resultsPanelElement, handlers);
}
