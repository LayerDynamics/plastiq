// Narrow session cache of the live part's edge polylines for "Project edges".
// Published by the viewport when a TransferMesh lands; consumed by the registry
// action without threading mesh through the sketch store (no heavy UI rewrite).

/** Flat world-space polylines `[x,y,z, …]` from the last built mesh, or null. */
let cache: ArrayLike<number>[] | null = null;

/** Replace the cache (null clears it — e.g. empty rebuild). */
export function setProjectableEdgePolylines(
  polylines: ArrayLike<number>[] | null,
): void {
  cache = polylines;
}

/** Snapshot of the current cache (or null when no body is loaded). */
export function getProjectableEdgePolylines(): ArrayLike<number>[] | null {
  return cache;
}
