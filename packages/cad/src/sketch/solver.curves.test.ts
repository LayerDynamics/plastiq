// Tests for the curved-geometry constraint/entity mappings added for the Sketcher
// completion (§13.3): radius equality (circle↔circle, arc↔arc), curve tangency
// (circle↔circle, circle↔arc) and the ellipse entity with point-on-ellipse. Each
// test drives the REAL planegcs wasm and asserts the solved geometry satisfies the
// relation numerically — never just the verdict — mirroring solver.mappings.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import {
  initSketchSolver,
  solveSketch,
  type SolverArc,
  type SolverCircle,
  type SolverEllipse,
  type SolverPoint,
} from "./solver.js";

beforeAll(async () => {
  await initSketchSolver();
}, 120_000);

function dist(a: SolverPoint, b: SolverPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("radius equality (real planegcs wasm)", () => {
  it("equalRadius drives a second circle to the first circle's radius", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true }, // circle 0 centre
      { x: 0.1, y: 0, fixed: true }, // circle 1 centre
    ];
    const circles: SolverCircle[] = [
      { center: 0, radius: 0.03 },
      { center: 1, radius: 0.06 }, // free radius, must fall to 0.03
    ];
    const r = solveSketch(pts, circles, [
      { kind: "radius", circle: 0, value: 0.03 }, // pin the reference radius
      { kind: "equalRadius", a: 0, b: 1 },
    ]);
    expect(r.radii[0]).toBeCloseTo(0.03, 6);
    expect(r.radii[1]).toBeCloseTo(0.03, 6);
    expect(r.verdict).toBe("well-constrained");
  });

  it("equalRadiusArc drives a second arc to the first arc's radius", () => {
    const pts: SolverPoint[] = [
      // arc 0 — fully fixed at radius 0.03
      { x: 0, y: 0, fixed: true }, // centre
      { x: 0.03, y: 0, fixed: true }, // start
      { x: 0, y: 0.03, fixed: true }, // end
      // arc 1 — fixed centre, free endpoints starting at radius ~0.05
      { x: 0.1, y: 0, fixed: true }, // centre
      { x: 0.15, y: 0, fixed: false }, // start (r≈0.05)
      { x: 0.1, y: 0.05, fixed: false }, // end (r≈0.05)
    ];
    const arcs: SolverArc[] = [
      { center: 0, start: 1, end: 2, radius: 0.03 },
      { center: 3, start: 4, end: 5, radius: 0.05 },
    ];
    const r = solveSketch(pts, [], [{ kind: "equalRadiusArc", a: 0, b: 1 }], [], arcs);
    // The angular position of arc 1 stays free, but its radius must equal arc 0's.
    expect(r.arcRadii[0]).toBeCloseTo(0.03, 6);
    expect(r.arcRadii[1]).toBeCloseTo(0.03, 6);
    // …and the geometry follows: endpoint 4 sits one (equal) radius from centre 3.
    expect(dist(r.points[3]!, r.points[4]!)).toBeCloseTo(0.03, 5);
  });

  it("equalRadiusCircleArc drives an arc to a circle's radius", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.04, y: 0, fixed: true },
      { x: 0.055, y: 0, fixed: false },
      { x: 0.04, y: 0.015, fixed: false },
    ];
    const circles: SolverCircle[] = [{ center: 0, radius: 0.015 }];
    const arcs: SolverArc[] = [{ center: 1, start: 2, end: 3, radius: 0.01 }];
    const r = solveSketch(
      pts,
      circles,
      [
        { kind: "radius", circle: 0, value: 0.015 },
        { kind: "equalRadiusCircleArc", circle: 0, arc: 0 },
      ],
      [],
      arcs,
    );
    expect(r.arcRadii[0]).toBeCloseTo(r.radii[0]!, 6);
    expect(dist(r.points[1]!, r.points[2]!)).toBeCloseTo(0.015, 5);
  });
});

describe("curve tangency (real planegcs wasm)", () => {
  it("tangentCircles makes two circles externally tangent (dist = r0 + r1)", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true }, // circle 0 centre
      { x: 0.1, y: 0, fixed: true }, // circle 1 centre, 0.10 away
    ];
    const circles: SolverCircle[] = [
      { center: 0, radius: 0.03 },
      { center: 1, radius: 0.06 }, // start near the external solution 0.07
    ];
    const r = solveSketch(pts, circles, [
      { kind: "radius", circle: 0, value: 0.03 }, // pin one radius so tangency drives the other
      { kind: "tangentCircles", a: 0, b: 1 },
    ]);
    const d = dist(r.points[0]!, r.points[1]!);
    // External tangency: centre distance equals the sum of the radii.
    expect(d).toBeCloseTo(r.radii[0]! + r.radii[1]!, 6);
    expect(r.radii[1]).toBeCloseTo(0.07, 6);
  });

  it("tangentArcCircle makes an arc externally tangent to a circle", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true }, // circle centre
      { x: 0.1, y: 0, fixed: true }, // arc centre, 0.10 away
      { x: 0.16, y: 0, fixed: false }, // arc start (r≈0.06)
      { x: 0.1, y: 0.06, fixed: false }, // arc end (r≈0.06)
    ];
    const circles: SolverCircle[] = [{ center: 0, radius: 0.03 }];
    const arcs: SolverArc[] = [{ center: 1, start: 2, end: 3, radius: 0.06 }];
    const r = solveSketch(
      pts,
      circles,
      [
        { kind: "radius", circle: 0, value: 0.03 }, // pin the circle radius
        { kind: "tangentArcCircle", circle: 0, arc: 0 },
      ],
      [],
      arcs,
    );
    const d = dist(r.points[0]!, r.points[1]!); // 0.10, fixed
    // External tangency: centre distance equals circle radius + arc radius.
    expect(d).toBeCloseTo(r.radii[0]! + r.arcRadii[0]!, 6);
    expect(r.arcRadii[0]).toBeCloseTo(0.07, 6);
  });

  it("tangentArcs makes two arcs externally tangent", () => {
    const pts: SolverPoint[] = [
      { x: 0, y: 0, fixed: true },
      { x: 0.01, y: 0, fixed: false },
      { x: 0, y: 0.01, fixed: false },
      { x: 0.04, y: 0, fixed: true },
      { x: 0.055, y: 0, fixed: false },
      { x: 0.04, y: 0.015, fixed: false },
    ];
    const arcs: SolverArc[] = [
      { center: 0, start: 1, end: 2, radius: 0.01 },
      { center: 3, start: 4, end: 5, radius: 0.015 },
    ];
    const r = solveSketch(pts, [], [{ kind: "tangentArcs", a: 0, b: 1 }], [], arcs);
    expect(dist(r.points[0]!, r.points[3]!)).toBeCloseTo(r.arcRadii[0]! + r.arcRadii[1]!, 5);
  });
});

describe("ellipse entity + point-on-ellipse (real planegcs wasm)", () => {
  it("pointOnEllipse forces the ellipse through a fixed point (focal-sum holds)", () => {
    const centre: SolverPoint = { x: 0, y: 0, fixed: true };
    const focus1: SolverPoint = { x: 0.04, y: 0, fixed: true };
    const onCurve: SolverPoint = { x: 0.02, y: 0.028, fixed: true }; // must lie on the ellipse
    const pts: SolverPoint[] = [centre, focus1, onCurve];
    const ellipses: SolverEllipse[] = [{ center: 0, focus1: 1, radmin: 0.02 }];
    const r = solveSketch(pts, [], [{ kind: "pointOnEllipse", p: 2, ellipse: 0 }], ellipses);

    const c = r.points[0]!;
    const f1 = r.points[1]!;
    const p = r.points[2]!;
    const radmin = r.ellipseRadmin[0]!;
    expect(Number.isFinite(radmin)).toBe(true);
    expect(radmin).toBeGreaterThan(0);

    // Linear eccentricity (centre→focus distance) and derived semi-major axis.
    const fLen = dist(c, f1);
    const semiMajor = Math.sqrt(radmin * radmin + fLen * fLen);
    // Second focus is the reflection of focus1 through the centre.
    const f2: SolverPoint = { x: 2 * c.x - f1.x, y: 2 * c.y - f1.y };
    // Defining property of an ellipse: |P−F1| + |P−F2| = 2·semiMajor.
    expect(dist(p, f1) + dist(p, f2)).toBeCloseTo(2 * semiMajor, 6);
    // Only radmin was free (centre/focus/point all fixed) → fully constrained.
    expect(r.verdict).toBe("well-constrained");
  });
});
