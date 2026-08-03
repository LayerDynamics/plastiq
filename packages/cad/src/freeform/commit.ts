// §15 Lane A(b) — freeform → B-rep commit path.
//
// Evaluates a dense point grid on the pure-TS NURBS surface (de Boor), then
// hands it to the kernel's surfaceFromPoints (GeomAPI_PointsToBSplineSurface →
// MakeFace). That is the client-side twin of services/nurbs STEP assembly, using
// symbols already bound in this wasm — no new embind trim required for the
// sample-and-fit route.
//
// Rational surfaces (cylinder/sphere generators) are committed as a dense
// sampling of their exact geometry, so the B-rep face is a high-fidelity fit
// rather than a re-encoding of the rational poles. Analytic exactness of the
// freeform generators is proven in generators.test.ts; this path proves the
// commit produces a valid face of the expected area for a plane.

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { surfaceFromPoints } from "../action/surface.js";
import { evaluate } from "./deBoor.js";
import { domain, type NurbsSurface, type Vec3 } from "./nurbsSurface.js";

export interface FreeformCommitOptions {
  /** Samples along U (default 16). Must be ≥ 2. */
  readonly samplesU?: number;
  /** Samples along V (default 16). Must be ≥ 2. */
  readonly samplesV?: number;
  /** Fitting tolerance passed to surfaceFromPoints (default 1e-6 m). */
  readonly tolerance?: number;
}

/**
 * Commit a freeform NURBS surface to a B-rep face Solid via dense de-Boor
 * sampling + `surfaceFromPoints`. Caller owns the returned Solid.
 */
export function freeformToFace(oc: Occt, surface: NurbsSurface, opts?: FreeformCommitOptions): Solid {
  const nU = opts?.samplesU ?? 16;
  const nV = opts?.samplesV ?? 16;
  if (!Number.isFinite(nU) || !Number.isFinite(nV) || nU < 2 || nV < 2) {
    throw new Error(`freeformToFace: samplesU/V must be finite and ≥ 2 (got ${nU}, ${nV})`);
  }

  const { u0, u1, v0, v1 } = domain(surface);
  const grid: Vec3[][] = [];
  for (let i = 0; i < nU; i++) {
    const u = u0 + ((u1 - u0) * i) / (nU - 1);
    const row: Vec3[] = [];
    for (let j = 0; j < nV; j++) {
      const v = v0 + ((v1 - v0) * j) / (nV - 1);
      row.push(evaluate(surface, u, v));
    }
    grid.push(row);
  }

  return surfaceFromPoints(oc, grid, {
    degU: Math.max(1, Math.min(3, surface.degU)),
    degV: Math.max(1, Math.min(3, surface.degV)),
    tolerance: opts?.tolerance ?? 1e-6,
  });
}
