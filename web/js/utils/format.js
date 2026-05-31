export function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0";
  }

  return value.toLocaleString();
}

export function formatDelta(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "0";
  }

  if (value > 0) {
    return `+${value}`;
  }

  return String(value);
}
