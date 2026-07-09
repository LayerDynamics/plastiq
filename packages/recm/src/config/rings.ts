// Ring geometry math in config units (no UI scale). These mirror the arc
// geometry RecmMenuView renders with — the component multiplies each result by
// its own `uiScale` — so any alternative renderer can share one source of truth
// for "where does ring N sit and how big is the whole menu".

import type { RecmConfig } from "../types.js";

type Geometry = Pick<
  RecmConfig,
  "centerSize" | "innerRadius" | "ringThickness" | "ringGap"
>;

/** Radius of the central hub (settings/label disc). */
export function ringCenterRadius(config: Pick<RecmConfig, "centerSize">): number {
  return Math.max(12, config.centerSize / 2);
}

/** Radial gap between the outer edge of one ring and the inner edge of the next. */
export function ringStep(config: Pick<RecmConfig, "ringThickness" | "ringGap">): number {
  return Math.max(0, config.ringThickness + config.ringGap);
}

/** Inner radius of the ring at `depth` (0 = the root ring nearest the hub). */
export function ringInnerRadius(depth: number, config: Geometry): number {
  const origin = ringCenterRadius(config) + Math.max(0, config.innerRadius);
  return origin + Math.max(0, depth) * ringStep(config);
}

/** Outer radius of the ring at `depth`. */
export function ringOuterRadius(depth: number, config: Geometry): number {
  return ringInnerRadius(depth, config) + Math.max(0, config.ringThickness);
}

/** Overall menu radius for a menu showing `ringCount` rings (includes a small
 *  outer padding matching the renderer's 8px halo). */
export function menuRadius(ringCount: number, config: Geometry): number {
  const rings = Math.max(1, ringCount);
  return ringOuterRadius(rings - 1, config) + 8;
}

/** Overall square size (width = height) for `ringCount` rings. */
export function menuDiameter(ringCount: number, config: Geometry): number {
  return menuRadius(ringCount, config) * 2;
}
