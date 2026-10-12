/**
 * Deterministic JSON serialization with sorted object keys.
 */
export function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}
