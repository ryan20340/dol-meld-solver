function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function normalizeIconId(value) {
  return normalizeNonNegativeInteger(value, 0);
}

export function buildXivIconUrl(iconId, options = {}) {
  const normalizedIconId = normalizeIconId(iconId);
  if (normalizedIconId <= 0) {
    return "";
  }

  const file = String(normalizedIconId).padStart(6, "0");
  const bucket = String(Math.floor(normalizedIconId / 1000) * 1000).padStart(6, "0");
  // Always use standard-size icons for faster loading.
  // `_hr1` is a larger-resolution asset variant, not HQ-specific art.
  const suffix = "";
  return `https://xivapi.com/i/${bucket}/${file}${suffix}.png`;
}

export function iconUrlFromRow(row, options = {}) {
  const iconId = normalizeIconId(row?.icon_id ?? row?.iconId);
  return buildXivIconUrl(iconId, options);
}
