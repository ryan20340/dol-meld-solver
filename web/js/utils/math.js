export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
