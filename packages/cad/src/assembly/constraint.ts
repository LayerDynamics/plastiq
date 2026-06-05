// Assembly mate constraints (SPEC-4 FR-27). A `Mate` couples geometry on two
// components; each contributes scalar residual equation(s) that vanish when the
// mate is satisfied. The 3D variational solver (solver.ts) drives the stacked
// residual to zero over the components' SE(3) poses.
//
// Geometry is referenced in a component's LOCAL frame (`MateRef`) and resolved
// to world by the component's pose. Residuals use cross-products for
// parallelism/collinearity (which vanish linearly at the solution, keeping the
// Jacobian well-conditioned) rather than dot=±1 (degenerate at the optimum).

import { cross, dot, sub, type Vec3 } from "../math/index.js";
import { tangentResidual } from "./tangent.js";

/** A geometric reference on a component, in that component's local frame. */
export interface MateRef {
  /** Index into the solver's component array. */
  readonly component: number;
  /** A local point (for coincident / distance / concentric / tangent). */
  readonly point?: Vec3;
  /** A local unit direction/axis/normal (for parallel / perp / angle / …). */
  readonly dir?: Vec3;
}

export type Mate =
  | { readonly kind: "coincident"; readonly a: MateRef; readonly b: MateRef }
  | { readonly kind: "distance"; readonly a: MateRef; readonly b: MateRef; readonly value: number }
  | { readonly kind: "parallel"; readonly a: MateRef; readonly b: MateRef }
  | { readonly kind: "perpendicular"; readonly a: MateRef; readonly b: MateRef }
  | { readonly kind: "angle"; readonly a: MateRef; readonly b: MateRef; readonly value: number }
  | { readonly kind: "concentric"; readonly a: MateRef; readonly b: MateRef }
  // Tangent: entity `a` (point + optional axis dir) tangent to plane `b`
  // (point + normal) at offset `radius` — a cylinder/sphere kissing a face.
  | { readonly kind: "tangent"; readonly a: MateRef; readonly b: MateRef; readonly radius: number };

export const MATE_KINDS = [
  "coincident",
  "distance",
  "parallel",
  "perpendicular",
  "angle",
  "concentric",
  "tangent",
] as const;

/** A reference resolved to world coordinates by a component pose. */
export interface WorldRef {
  readonly point: Vec3;
  readonly dir: Vec3;
}

/** Residual scalars for `mate` given its two refs resolved to world. */
export function mateResiduals(mate: Mate, a: WorldRef, b: WorldRef): number[] {
  switch (mate.kind) {
    case "coincident": {
      const d = sub(a.point, b.point);
      return [d[0], d[1], d[2]];
    }
    case "distance": {
      const d = sub(a.point, b.point);
      return [Math.hypot(d[0], d[1], d[2]) - mate.value];
    }
    case "parallel": {
      // cross == 0 ⇔ parallel; 3 components (rank 2 — two rotational DOF).
      const c = cross(a.dir, b.dir);
      return [c[0], c[1], c[2]];
    }
    case "perpendicular":
      return [dot(a.dir, b.dir)];
    case "angle":
      // dot == cos(angle): the directed angle between the axes equals `value`.
      return [dot(a.dir, b.dir) - Math.cos(mate.value)];
    case "concentric": {
      // Collinear axes: directions parallel AND the offset between the axis
      // points is parallel to the axis (no perpendicular component).
      const par = cross(a.dir, b.dir);
      const off = cross(a.dir, sub(b.point, a.point));
      return [par[0], par[1], par[2], off[0], off[1], off[2]];
    }
    case "tangent":
      return tangentResidual(a, b, mate.radius);
  }
}
