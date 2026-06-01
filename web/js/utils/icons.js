import { normalizeNonNegativeInteger } from "./normalize.js";

export function normalizeIconId(value) {
  return normalizeNonNegativeInteger(value, 0);
}

export function buildXivIconUrl(iconId, options = {}) {
  const normalizedIconId = normalizeIconId(iconId);
  if (normalizedIconId <= 0) {
    return "";
  }

  const file = String(normalizedIconId).padStart(6, "0");
  const folder = String(Math.floor(normalizedIconId / 1000) * 1000).padStart(6, "0");
  // FFXIV stores the HQ item icon as a separate `hq/` variant inside the same
  // icon folder (ui/icon/<folder>/hq/<file>.tex), not a `_hq`/`_hr1` suffix.
  // Not every item has one, so a global <img> error handler (see app.js)
  // falls back to the normal icon if the HQ variant 404s.
  const hqPath = options?.useHqVariant === true ? "hq/" : "";
  const path = `ui/icon/${folder}/${hqPath}${file}.tex`;
  return `https://v2.xivapi.com/api/asset?path=${path}&format=png`;
}

export function iconUrlFromRow(row, options = {}) {
  const iconId = normalizeIconId(row?.icon_id ?? row?.iconId);
  return buildXivIconUrl(iconId, options);
}
