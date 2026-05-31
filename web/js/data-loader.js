const PROCESSED_FILE_NAMES = Object.freeze({
  baseParams: "base_params.json",
  gear: "gear.json",
  materia: "materia.json",
  food: "food.json",
  rules: "rules.json",
});
const DEFAULT_PROCESSED_BASE_URL = new URL("../../data/processed/", import.meta.url);

async function loadJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${response.status} while fetching ${url}`);
  }

  return response.json();
}

function countRecords(value) {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (!value || typeof value !== "object") {
    return 0;
  }

  if (Array.isArray(value.items)) {
    return value.items.length;
  }

  return Object.keys(value).length;
}

function normalizeProcessedBaseUrl(basePath) {
  if (basePath instanceof URL) {
    return basePath;
  }

  if (typeof basePath === "string" && basePath.trim()) {
    const trimmed = basePath.trim();
    const withSlash = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
    return new URL(withSlash, import.meta.url);
  }

  return DEFAULT_PROCESSED_BASE_URL;
}

export async function loadProcessedData(basePath = DEFAULT_PROCESSED_BASE_URL) {
  const processedBaseUrl = normalizeProcessedBaseUrl(basePath);
  const pairs = await Promise.all(
    Object.entries(PROCESSED_FILE_NAMES).map(async ([key, fileName]) => {
      const data = await loadJson(new URL(fileName, processedBaseUrl).toString());
      return [key, data];
    }),
  );

  return Object.fromEntries(pairs);
}

export function summarizeProcessedData(data) {
  return {
    baseParams: countRecords(data?.baseParams),
    gear: countRecords(data?.gear),
    materia: countRecords(data?.materia),
    food: countRecords(data?.food),
    rules: countRecords(data?.rules),
  };
}
