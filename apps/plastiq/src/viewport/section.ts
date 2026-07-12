// Section analysis (FR-14) — Fusion-style cut-plane math.
//
// A section removes one half-space so the user can see inside the solid. The
// plane is defined either by a world axis + fraction of the bbox (default), or
// by an arbitrary plane (face-derived). three.js clips points where
// `normal · point + constant < 0`.

export type SectionAxis = "x" | "y" | "z";

/** Axis-aligned section: cut along world X/Y/Z at fraction `t` of the solid extent. */
export interface AxisSection {
  readonly kind?: "axis"; // optional for back-compat with { axis, t } records
  readonly axis: SectionAxis;
  /** Fraction of the solid's [min,max] extent on that axis; 0 = min, 1 = max. */
  readonly t: number;
  /** When true, keep the opposite half-space (Fusion flip). */
  readonly flip?: boolean;
}

/**
 * Arbitrary plane section (e.g. from a picked face): world origin + unit normal.
 * `offset` is metres along the normal from `origin` (0 = through the face).
 */
export interface PlaneSection {
  readonly kind: "plane";
  readonly origin: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly offset?: number;
  readonly flip?: boolean;
}

/** Active section analysis state (null = off). */
export type SectionAnalysis = AxisSection | PlaneSection;

/** A world-space clipping plane. three.js clips where
 * `normal · point + constant < 0` (the negative side is removed). */
export interface SectionPlane {
  normal: [number, number, number];
  constant: number;
}

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));

function isPlaneSection(s: SectionAnalysis): s is PlaneSection {
  return (s as PlaneSection).kind === "plane";
}

/**
 * The clipping plane for a section cut along `axis` at fraction `t` of the solid's
 * extent `[min, max]` on that axis. The half-space whose coordinate is GREATER
 * than the cut is removed (unless `flip`). `t = 1` cuts at `max` (nothing
 * removed without flip); `t = 0` cuts at `min`.
 *
 * The unflipped normal points back along the axis (e.g. −X), so
 * `distance(p) = offset − p[axis]`, negative exactly when `p[axis] > offset`.
 */
export function sectionPlane(
  min: number,
  max: number,
  axis: SectionAxis,
  t: number,
  flip = false,
): SectionPlane {
  const offset = min + clamp01(t) * (max - min);
  const normal: [number, number, number] =
    axis === "x" ? [-1, 0, 0] : axis === "y" ? [0, -1, 0] : [0, 0, -1];
  if (!flip) return { normal, constant: offset };
  // Flip: reverse normal and negate constant so the kept half-space swaps.
  return { normal: [-normal[0], -normal[1], -normal[2]], constant: -offset };
}

/**
 * Clipping plane for an arbitrary (face-derived) section. `offset` metres along
 * the unit normal from `origin`; `flip` swaps the kept half-space.
 */
export function sectionPlaneFromOriginNormal(
  origin: readonly [number, number, number],
  normalIn: readonly [number, number, number],
  offset = 0,
  flip = false,
): SectionPlane {
  const len = Math.hypot(normalIn[0], normalIn[1], normalIn[2]) || 1;
  let n: [number, number, number] = [
    normalIn[0] / len,
    normalIn[1] / len,
    normalIn[2] / len,
  ];
  // Point on plane: origin + offset·n. Plane equation n·x + c = 0 ⇒ c = −n·p0.
  // three.js clips n·x + c < 0. Unflipped: remove the side the normal points into
  // (half-space n·(x − p0) > 0), matching Fusion "hide the side toward the normal".
  const p0: [number, number, number] = [
    origin[0] + n[0] * offset,
    origin[1] + n[1] * offset,
    origin[2] + n[2] * offset,
  ];
  // For consistency with axis sections (remove the "greater" side), use −n so
  // we remove points with positive projection along the face outward normal
  // (typically the exterior / far side from the solid interior).
  n = [-n[0], -n[1], -n[2]];
  let constant = -(n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2]);
  if (flip) {
    n = [-n[0], -n[1], -n[2]];
    constant = -constant;
  }
  return { normal: n, constant };
}

/** Build a three.js-ready plane from any SectionAnalysis + the solid bbox. */
export function resolveSectionPlane(
  section: SectionAnalysis,
  bbox: { min: [number, number, number]; max: [number, number, number] },
): SectionPlane {
  if (isPlaneSection(section)) {
    return sectionPlaneFromOriginNormal(
      section.origin,
      section.normal,
      section.offset ?? 0,
      section.flip === true,
    );
  }
  const axis = section.axis;
  const min = axis === "x" ? bbox.min[0] : axis === "y" ? bbox.min[1] : bbox.min[2];
  const max = axis === "x" ? bbox.max[0] : axis === "y" ? bbox.max[1] : bbox.max[2];
  return sectionPlane(min, max, axis, section.t, section.flip === true);
}

/**
 * Inverse of {@link sectionPlane}'s offset map: world coordinate along the axis
 * → fraction `t ∈ [0,1]`. Used by the draggable section gizmo write-back.
 */
export function sectionTFromOffset(min: number, max: number, value: number): number {
  const span = max - min;
  if (span === 0) return 0;
  return clamp01((value - min) / span);
}

/** World-space point on the section plane at the bbox centre (for the gizmo). */
export function sectionHandlePosition(
  section: SectionAnalysis,
  bbox: { min: [number, number, number]; max: [number, number, number] },
): [number, number, number] {
  const cx = (bbox.min[0] + bbox.max[0]) / 2;
  const cy = (bbox.min[1] + bbox.max[1]) / 2;
  const cz = (bbox.min[2] + bbox.max[2]) / 2;
  if (isPlaneSection(section)) {
    const o = section.origin;
    const n = section.normal;
    const off = section.offset ?? 0;
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [o[0] + (n[0] / len) * off, o[1] + (n[1] / len) * off, o[2] + (n[2] / len) * off];
  }
  const axis = section.axis;
  const min = axis === "x" ? bbox.min[0] : axis === "y" ? bbox.min[1] : bbox.min[2];
  const max = axis === "x" ? bbox.max[0] : axis === "y" ? bbox.max[1] : bbox.max[2];
  const offset = min + clamp01(section.t) * (max - min);
  if (axis === "x") return [offset, cy, cz];
  if (axis === "y") return [cx, offset, cz];
  return [cx, cy, offset];
}

export function isAxisSection(s: SectionAnalysis | null | undefined): s is AxisSection {
  return s != null && !isPlaneSection(s);
}
