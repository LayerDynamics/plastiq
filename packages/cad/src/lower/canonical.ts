// Canonical serialization (SPEC-4 NFR-2 reproducibility; reused by model
// serialization in M5). Produces a deterministic string for a value: object
// keys are emitted in sorted order so two structurally-equal results serialize
// byte-identically. f64 values use JSON's exact round-trippable representation.

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON for `value` — stable key order, exact f64. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
