export function normalizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function normalizeOptionalPriority(value) {
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
