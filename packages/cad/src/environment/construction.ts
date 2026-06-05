// Construction (reference) geometry (SPEC-4 FR-19): points, axes, and lines that
// participate in sketches/features/mates but belong to no solid's boundary.

import { normalize, type Vec3 } from "../math/index.js";

export interface ConstructionPoint {
  readonly kind: "point";
  readonly at: Vec3;
}

export interface ConstructionAxis {
  readonly kind: "axis";
  readonly origin: Vec3;
  /** Unit direction. */
  readonly direction: Vec3;
}

export interface ConstructionLine {
  readonly kind: "line";
  readonly start: Vec3;
  readonly end: Vec3;
}

export type ConstructionGeometry = ConstructionPoint | ConstructionAxis | ConstructionLine;

export function constructionPoint(at: Vec3): ConstructionPoint {
  return { kind: "point", at };
}

/** A reference axis; `direction` is normalized (throws on a zero direction). */
export function constructionAxis(origin: Vec3, direction: Vec3): ConstructionAxis {
  return { kind: "axis", origin, direction: normalize(direction) };
}

export function constructionLine(start: Vec3, end: Vec3): ConstructionLine {
  return { kind: "line", start, end };
}
