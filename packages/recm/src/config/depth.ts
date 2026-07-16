// Depth defaults + guards. A RECM "depth" is a ring index: the root ring is
// depth 0, its expansion depth 1, and so on. `maxDepth` bounds how many rings
// can ever be shown, so valid ring indices are 0 .. maxDepth-1.

import type { RecmConfig } from "../types.js";

/** Default cap on ring count (matches createRecmConfig's fallback). */
export const DEFAULT_MAX_DEPTH = 3;

/** Hard ceiling — protects the arc renderer from pathological configs. */
export const MAX_SUPPORTED_DEPTH = 8;

/** Clamp a raw maxDepth into the supported [1, MAX_SUPPORTED_DEPTH] range. */
export function clampMaxDepth(maxDepth: number): number {
  if (!Number.isFinite(maxDepth)) return DEFAULT_MAX_DEPTH;
  return Math.max(1, Math.min(MAX_SUPPORTED_DEPTH, Math.floor(maxDepth)));
}

/** Clamp a ring index into the range this config actually renders. */
export function clampDepth(depth: number, config: Pick<RecmConfig, "maxDepth">): number {
  const max = clampMaxDepth(config.maxDepth);
  if (!Number.isFinite(depth)) return 0;
  return Math.max(0, Math.min(max - 1, Math.floor(depth)));
}

/** True when a ring at `depth` is within the configured cap. */
export function isDepthVisible(depth: number, config: Pick<RecmConfig, "maxDepth">): boolean {
  return depth >= 0 && depth < clampMaxDepth(config.maxDepth);
}
