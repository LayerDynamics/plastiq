// Section view (FR-14 family): a clipping plane that cuts the rendered solid so
// the user can see inside it. This is the pure geometry of the cut; SceneController
// turns the result into a THREE.Plane fed to renderer.clippingPlanes (world space).

export type SectionAxis = "x" | "y" | "z";

/** A world-space clipping plane. three.js clips points where
 * `normal · point + constant < 0` (i.e. the negative side is removed). */
export interface SectionPlane {
  normal: [number, number, number];
  constant: number;
}

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

/**
 * The clipping plane for a section cut along `axis` at fraction `t` of the solid's
 * extent `[min, max]` on that axis. The half-space whose coordinate is GREATER
 * than the cut is removed, exposing the interior. `t = 1` cuts at `max` (nothing
 * removed); `t = 0` cuts at `min` (everything removed). `t` is clamped to [0,1].
 *
 * The normal points back along the axis (e.g. −X), so `distance(p) = offset −
 * p[axis]`, which is negative exactly when `p[axis] > offset` — the far side.
 */
export function sectionPlane(min: number, max: number, axis: SectionAxis, t: number): SectionPlane {
  const offset = min + clamp01(t) * (max - min);
  const normal: [number, number, number] =
    axis === "x" ? [-1, 0, 0] : axis === "y" ? [0, -1, 0] : [0, 0, -1];
  return { normal, constant: offset };
}

/**
 * Inverse of {@link sectionPlane}'s offset map: given a world-space coordinate
 * `value` along the axis (e.g. the dragged gizmo handle's position), return the
 * fraction `t ∈ [0,1]` of the extent `[min, max]` it represents. This is the
 * draggable section gizmo's write-back: handle position → store `t`. A degenerate
 * extent (`max === min`) maps everything to 0. Result is clamped to [0,1].
 */
export function sectionTFromOffset(min: number, max: number, value: number): number {
  const span = max - min;
  if (span === 0) return 0;
  return clamp01((value - min) / span);
}
