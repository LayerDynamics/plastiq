// §15 Lane B — convert the NURBS service wire form (SPEC-12 §6.2 snake_case
// compact knots) into the freeform pillar's NurbsSurface so a fit can land as an
// editable freeform feature instead of an opaque importStep.

import { makeNurbsSurface, type NurbsSurface, type Vec3 } from "./nurbsSurface.js";

/** Compact §6.2 knot vector → full non-decreasing knot vector (repeated mults). */
export function expandCompactKnots(unique: readonly number[], mults: readonly number[]): number[] {
  if (unique.length !== mults.length) {
    throw new Error(
      `expandCompactKnots: unique length ${unique.length} != mults length ${mults.length}`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < unique.length; i++) {
    const u = unique[i]!;
    const m = mults[i]!;
    if (!Number.isFinite(u) || !Number.isInteger(m) || m < 1) {
      throw new Error(`expandCompactKnots: bad knot/mult at ${i} (${u}, ${m})`);
    }
    for (let k = 0; k < m; k++) out.push(u);
  }
  return out;
}

/**
 * Wire form of one fitted B-spline surface (snake_case, compact knots) as returned
 * by `@plastiq/nurbs` / the nurbs service. Kept structural (not imported from
 * @plastiq/nurbs) so the kernel package stays free of that dependency.
 */
export interface ServiceNurbsSurface {
  poles: number[][][];
  weights: number[][];
  u_knots: number[];
  v_knots: number[];
  u_mults: number[];
  v_mults: number[];
  u_degree: number;
  v_degree: number;
}

/** Convert a service surface JSON into a freeform {@link NurbsSurface}. */
export function serviceSurfaceToNurbs(s: ServiceNurbsSurface): NurbsSurface {
  if (!Array.isArray(s.poles) || s.poles.length < 2) {
    throw new Error("serviceSurfaceToNurbs: poles need ≥2 rows");
  }
  const controlNet: Vec3[][] = s.poles.map((row, i) => {
    if (!Array.isArray(row) || row.length < 2) {
      throw new Error(`serviceSurfaceToNurbs: poles[${i}] needs ≥2 points`);
    }
    return row.map((p, j) => {
      if (!Array.isArray(p) || p.length !== 3) {
        throw new Error(`serviceSurfaceToNurbs: poles[${i}][${j}] must be [x,y,z]`);
      }
      return [Number(p[0]), Number(p[1]), Number(p[2])] as Vec3;
    });
  });

  const knotsU = expandCompactKnots(s.u_knots, s.u_mults);
  const knotsV = expandCompactKnots(s.v_knots, s.v_mults);
  const weights =
    Array.isArray(s.weights) && s.weights.length > 0 ? s.weights.map((r) => r.slice()) : undefined;

  return makeNurbsSurface({
    degU: s.u_degree,
    degV: s.v_degree,
    knotsU,
    knotsV,
    controlNet,
    ...(weights ? { weights } : {}),
  });
}
