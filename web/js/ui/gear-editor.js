import { getGearRowTrackedStats, statSum } from "../utils/gear-stats.js";
import { iconUrlFromRow } from "../utils/icons.js";

const SLOT_ORDER = Object.freeze([
  "main_hand",
  "off_hand",
  "head",
  "body",
  "hands",
  "waist",
  "legs",
  "feet",
  "ears",
  "neck",
  "wrists",
  "ring_left",
  "ring_right",
  "soul_crystal",
]);

const SLOT_SOURCE_BY_KEY = Object.freeze({
  ring_left: "ring",
  ring_right: "ring",
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
  ring_left: "Ring Left",
  ring_right: "Ring Right",
  ring: "Ring",
  soul_crystal: "Soul Crystal",
});

const IMAGE_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const INITIAL_DROPDOWN_PRELOAD_COUNT = 12;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getGearRows(gearData) {
  if (!gearData || typeof gearData !== "object") {
    return [];
  }

  if (Array.isArray(gearData.rows)) {
    return gearData.rows;
  }

  if (Array.isArray(gearData)) {
    return gearData;
  }

  return [];
}

function isDoLGearRow(row) {
  if (!row || typeof row !== "object") {
    return false;
  }
  const baseTotal = statSum(getGearRowTrackedStats(row, { useHq: true }));
  return baseTotal > 0 && typeof row.slot === "string" && row.slot.length > 0;
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

function buildGearBySlot(gearRows) {
  const slotMap = new Map();
  for (const row of gearRows) {
    if (!isDoLGearRow(row)) {
      continue;
    }
    if (!slotMap.has(row.slot)) {
      slotMap.set(row.slot, []);
    }
    slotMap.get(row.slot).push(row);
  }

  for (const [slot, rows] of slotMap.entries()) {
    rows.sort((left, right) => {
      const itemLevelDiff = (Number(right.item_level) || 0) - (Number(left.item_level) || 0);
      if (itemLevelDiff !== 0) {
        return itemLevelDiff;
      }
      const nameDiff = String(left.name ?? "").localeCompare(String(right.name ?? ""));
      if (nameDiff !== 0) {
        return nameDiff;
      }
      return (Number(left.id) || 0) - (Number(right.id) || 0);
    });
    slotMap.set(slot, rows);
  }

  return slotMap;
}

function buildGearOptionEntries(slotRows, selectedId, useHq) {
  const entries = slotRows.map((row) => {
    const rowId = Number(row?.id) || 0;
    const slotsInfo = Number(row?.guaranteed_materia_slots) || 0;
    const advInfo = row?.advanced_melding_permitted ? "+adv" : "";
    const quality = useHq && row?.can_be_hq ? "HQ" : "NQ";
    const label = `${row?.name ?? `Item ${rowId}`} (i${row?.item_level ?? "?"}, ${slotsInfo}${advInfo})`;
    const iconUrl = iconUrlFromRow(row, { useHqVariant: quality === "HQ" });
    return {
      value: rowId,
      label,
      quality,
      iconUrl,
    };
  });

  entries.push({
    value: 0,
    label: "None",
    quality: "NQ",
    iconUrl: "",
  });

  const selectedEntry =
    entries.find((entry) => entry.value === selectedId) ??
    entries.find((entry) => entry.value !== 0) ??
    entries[entries.length - 1];

  return {
    entries,
    selectedEntry,
  };
}

function buildDropdownOptionHtml(option, isSelected = false) {
  const iconHtml = option?.iconUrl
    ? `<img class="item-icon item-icon-slot" src="${IMAGE_PLACEHOLDER_SRC}" data-src="${option.iconUrl}" alt="${escapeHtml(`${option?.label ?? "Item"} icon`)}" loading="lazy" decoding="async">`
    : '<span class="item-icon item-icon-slot item-icon-placeholder" aria-hidden="true"></span>';

  return `
    <button
      type="button"
      class="icon-dropdown-option${isSelected ? " icon-dropdown-option-selected" : ""}"
      data-icon-dropdown-value="${Number(option?.value) || 0}"
      title="${escapeHtml(option?.label ?? "")}"
    >
      <span class="item-with-icon">
        ${iconHtml}
        <span>${escapeHtml(option?.label ?? "Item")}</span>
      </span>
      <span class="icon-dropdown-quality">${escapeHtml(option?.quality ?? "NQ")}</span>
    </button>
  `;
}

function buildSlotEditorRows(slotMap, selectedGearBySlot, options = {}) {
  const lockOffHand = !!options.lockOffHand;
  const useHq = options.useHq === true;
  const orderedSlots = SLOT_ORDER.filter((slotKey) => {
    const sourceSlot = SLOT_SOURCE_BY_KEY[slotKey] ?? slotKey;
    return slotMap.has(sourceSlot) && !(lockOffHand && sourceSlot === "off_hand");
  });

  return orderedSlots
    .map((slotKey) => {
      const sourceSlot = SLOT_SOURCE_BY_KEY[slotKey] ?? slotKey;
      const slotRows = slotMap.get(sourceSlot) ?? [];
      const selectedSlotValue = Number(selectedGearBySlot?.[slotKey]);
      const legacyRingValue = sourceSlot === "ring" ? Number(selectedGearBySlot?.ring) : NaN;
      const selectedValue = Number.isFinite(selectedSlotValue) ? selectedSlotValue : legacyRingValue;
      const selectedId = Number.isFinite(selectedValue) ? selectedValue : Number(slotRows[0]?.id) || 0;
      const { entries, selectedEntry } = buildGearOptionEntries(slotRows, selectedId, useHq);
      const selectedIconHtml = selectedEntry?.iconUrl
        ? `<img class="item-icon item-icon-slot" src="${selectedEntry.iconUrl}" alt="${escapeHtml(`${selectedEntry?.label ?? "Item"} icon`)}" loading="lazy" decoding="async">`
        : '<span class="item-icon item-icon-slot item-icon-placeholder" aria-hidden="true"></span>';
      const optionsHtml = entries
        .map((entry) => buildDropdownOptionHtml(entry, entry?.value === selectedEntry?.value))
        .join("");

      return `
        <div class="input-row input-row-wide">
          <label for="gear-slot-${slotKey}">${SLOT_LABELS[slotKey] ?? slotKey}</label>
          <div class="icon-dropdown" data-gear-slot="${escapeHtml(slotKey)}" tabindex="0">
            <button type="button" id="gear-slot-${slotKey}" class="icon-dropdown-trigger" data-icon-dropdown-trigger aria-haspopup="listbox" aria-expanded="false">
              <span class="item-with-icon">
                ${selectedIconHtml}
                <span class="icon-dropdown-trigger-label">${escapeHtml(selectedEntry?.label ?? "None")}</span>
              </span>
              <span class="icon-dropdown-quality">${escapeHtml(selectedEntry?.quality ?? "NQ")}</span>
              <span class="icon-dropdown-caret" aria-hidden="true">&#9662;</span>
            </button>
            <div class="icon-dropdown-menu" role="listbox" aria-label="${escapeHtml(SLOT_LABELS[slotKey] ?? slotKey)} options">
              ${optionsHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function closeAllGearDropdowns(gearEditor) {
  gearEditor.querySelectorAll(".icon-dropdown[data-gear-slot]").forEach((dropdown) => {
    dropdown.classList.remove("open");
    const trigger = dropdown.querySelector("[data-icon-dropdown-trigger]");
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
  const pendingImages = Array.from(menu.querySelectorAll("img[data-src]"));
  pendingImages
    .slice(0, Math.max(0, Number(limit) || 0))
    .forEach((img) => loadPendingDropdownImage(img));
}

function ensureDropdownLazyImageLoading(dropdown) {
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

  // Fallback: no IntersectionObserver support.
  pendingImages.slice(0, 20).forEach((img) => {
    loadPendingDropdownImage(img);
  });
}

function wireGearDropdowns(gearEditor, handlers = {}) {
  const dropdowns = gearEditor.querySelectorAll(".icon-dropdown[data-gear-slot]");
  dropdowns.forEach((dropdown) => {
    const trigger = dropdown.querySelector("[data-icon-dropdown-trigger]");
    if (trigger) {
      trigger.addEventListener("click", () => {
        const wasOpen = dropdown.classList.contains("open");
        closeAllGearDropdowns(gearEditor);
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

    dropdown.querySelectorAll("[data-icon-dropdown-value]").forEach((optionButton) => {
      optionButton.addEventListener("click", (event) => {
        const slot = dropdown.getAttribute("data-gear-slot");
        const itemId = event.currentTarget.getAttribute("data-icon-dropdown-value");
        dropdown.classList.remove("open");
        if (trigger) {
          trigger.setAttribute("aria-expanded", "false");
        }
        handlers.onGearChange?.(slot, itemId);
      });
    });
  });
}

export function renderGearEditor(controlsPanelElement, state, handlers = {}) {
  const gearEditor = controlsPanelElement.querySelector("#gear-editor");

  if (!gearEditor) {
    return 0;
  }

  const allGearRows = getGearRows(state.data?.gear);
  const slotMap = buildGearBySlot(allGearRows);
  const mainHandRows = slotMap.get("main_hand") ?? [];
  const selectedMainHandId = Number(state.selectedGearBySlot?.main_hand);
  const explicitMainHandNone = selectedMainHandId === 0;
  const selectedMainHandRow =
    explicitMainHandNone
      ? null
      : mainHandRows.find((row) => Number(row.id) === selectedMainHandId) ?? mainHandRows[0] ?? null;
  const lockOffHand = isFisherPrimaryToolRow(selectedMainHandRow);
  const slotEditors = buildSlotEditorRows(slotMap, state.selectedGearBySlot, {
    lockOffHand,
    useHq: state?.gear?.useHq === true,
  });
  const offHandNote = lockOffHand
    ? '<p class="muted">Off Hand is disabled for Fisher main-hand tools.</p>'
    : "";
  const hqChecked = state?.gear?.useHq ? "checked" : "";

  gearEditor.innerHTML = `
    <h3>Gear Set</h3>
    <label class="checkbox-row" for="gear-hq">
      <input id="gear-hq" type="checkbox" ${hqChecked}>
      <span>Use HQ stats where available</span>
    </label>
    ${offHandNote}
    <div class="stack">${slotEditors}</div>
  `;

  const hqCheckbox = gearEditor.querySelector("#gear-hq");
  if (hqCheckbox) {
    hqCheckbox.addEventListener("change", (event) => {
      handlers.onGearQualityChange?.(event.target.checked);
    });
  }

  wireGearDropdowns(gearEditor, handlers);
}
