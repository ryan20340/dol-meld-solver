import { normalizeNonNegativeInteger, normalizeOptionalPriority } from "./utils/normalize.js";
import { STAT_KEYS } from "./utils/stats.js";

export const ADVANCED_STAT_DUMP = Object.freeze({
  NONE: "none",
  GATHERING: "gathering",
  PERCEPTION: "perception",
  GP: "gp",
  EVEN: "even",
});

const ADVANCED_STAT_DUMP_MODES = new Set(Object.values(ADVANCED_STAT_DUMP));

export function normalizeAdvancedStatDump(value, fallback = ADVANCED_STAT_DUMP.NONE) {
  const normalizedFallback = ADVANCED_STAT_DUMP_MODES.has(String(fallback ?? "").trim().toLowerCase())
    ? String(fallback).trim().toLowerCase()
    : ADVANCED_STAT_DUMP.NONE;
  const raw = String(value ?? "").trim().toLowerCase();
  if (ADVANCED_STAT_DUMP_MODES.has(raw)) {
    return raw;
  }
  return normalizedFallback;
}

export function createDefaultBreakpoint(index = 1) {
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

export function createDefaultProfile(index = 1) {
  const safeIndex = Math.max(1, normalizeNonNegativeInteger(index, 1));
  return {
    id: `profile_${safeIndex}`,
    name: `Profile ${safeIndex}`,
    enabled: true,
    useHq: true,
    statDump: ADVANCED_STAT_DUMP.NONE,
    allowedFoodIds: [],
    breakpoints: [],
  };
}

export function buildDefaultAdvancedState() {
  return {
    enabled: false,
    activeProfileIndex: 0,
    nextProfileId: 2,
    nextBreakpointId: 1,
    profiles: [createDefaultProfile(1)],
  };
}

export function normalizeBreakpoint(raw, fallbackIndex = 1) {
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

export function normalizeAdvancedProfile(raw, fallbackIndex = 1, options = {}) {
  const fallback = createDefaultProfile(fallbackIndex);
  const keepEmptyFoodSelection = options?.keepEmptyFoodSelection === true;
  const normalizedFoodIds = (Array.isArray(options?.allFoodIds) ? options.allFoodIds : [])
    .map((itemId) => normalizeNonNegativeInteger(itemId, 0))
    .filter((itemId) => itemId > 0);
  const validFoodIds = new Set(normalizedFoodIds);

  const hasExplicitFoodSelection = Array.isArray(raw?.allowedFoodIds);
  const rawAllowedFoodIds = hasExplicitFoodSelection
    ? raw.allowedFoodIds
        .map((itemId) => normalizeNonNegativeInteger(itemId, 0))
        .filter((itemId) => validFoodIds.has(itemId))
    : [];
  const uniqueAllowedFoodIds = Array.from(new Set(rawAllowedFoodIds));
  const allowedFoodIds =
    uniqueAllowedFoodIds.length > 0
      ? uniqueAllowedFoodIds
      : keepEmptyFoodSelection && hasExplicitFoodSelection
        ? []
        : normalizedFoodIds;

  const rawBreakpoints = Array.isArray(raw?.breakpoints) ? raw.breakpoints : [];
  return {
    id: String(raw?.id ?? fallback.id),
    name: String(raw?.name ?? fallback.name).trim() || fallback.name,
    enabled: raw?.enabled !== false,
    useHq: raw?.useHq !== false,
    statDump: normalizeAdvancedStatDump(raw?.statDump, fallback.statDump),
    allowedFoodIds,
    breakpoints: rawBreakpoints.map((bp, idx) => normalizeBreakpoint(bp, idx + 1)),
  };
}

export function normalizeAdvancedConfig(raw, options = {}) {
  const fallback = buildDefaultAdvancedState();
  const rawProfiles = Array.isArray(raw?.profiles) ? [...raw.profiles] : [];
  if (rawProfiles.length === 0) {
    rawProfiles.push(createDefaultProfile(1));
  }

  const profileOptions = {
    keepEmptyFoodSelection: options?.keepEmptyFoodSelection === true,
    allFoodIds: Array.isArray(options?.allFoodIds) ? options.allFoodIds : [],
  };
  const profiles = rawProfiles.map((profile, index) =>
    normalizeAdvancedProfile(profile, index + 1, profileOptions),
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
