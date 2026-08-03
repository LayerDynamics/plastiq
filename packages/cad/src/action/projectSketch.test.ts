// Real-OCCT tests for §13.3 project-body-edges: sectionCurves → plane UV segments.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { offsetPlane, planeXY, planeYZ, worldPointToPlane } from "../env/plane.js";
import {
  sectionCurvesToPlaneSegments,
  worldPolylinesToPlaneSegments,
} from "./projectSketch.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("worldPointToPlane", () => {
  it("round-trips planePointToWorld on XY", () => {
    const p = worldPointToPlane(planeXY(), [0.03, -0.02, 0]);
    expect(p.u).toBeCloseTo(0.03, 12);
    expect(p.v).toBeCloseTo(-0.02, 12);
    expect(p.height).toBeCloseTo(0, 12);
  });

  it("reports height off the plane", () => {
    const p = worldPointToPlane(planeXY(), [1, 2, 0.005]);
    expect(p.u).toBeCloseTo(1, 12);
    expect(p.v).toBeCloseTo(2, 12);
    expect(p.height).toBeCloseTo(0.005, 12);
  });
});

describe("worldPolylinesToPlaneSegments (pure)", () => {
  it("projects coplanar chords; drops off-plane chords", () => {
    // Two edges on z=0, one edge floating at z=1 mm (above maxOffPlane default).
    const onPlane = [0, 0, 0, 0.05, 0, 0];
    const alsoOn = [0.05, 0, 0, 0.05, 0.04, 0];
    const off = [0, 0, mm(1), 0.01, 0, mm(1)];
    const segs = worldPolylinesToPlaneSegments(planeXY(), [onPlane, alsoOn, off]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.a).toEqual([0, 0]);
    expect(segs[0]!.b[0]).toBeCloseTo(0.05, 12);
    expect(segs[1]!.b[1]).toBeCloseTo(0.04, 12);
  });

  it("drops degenerate zero-length chords", () => {
    const segs = worldPolylinesToPlaneSegments(planeXY(), [[1, 2, 0, 1, 2, 0]]);
    expect(segs).toHaveLength(0);
  });
});

describe("sectionCurvesToPlaneSegments (real OCCT)", () => {
  it("mid-XY section of a box → 4 rectangle sides in plane UV", () => {
    const dx = mm(60);
    const dy = mm(40);
    const dz = mm(30);
    const box = makeBox(oc, dx, dy, dz);
    // makeBox is origin-centred? Check — typically [0,dx]×[0,dy]×[0,dz] or centred.
    // packages/cad makeBox is corner at origin (see primitives).
    const mid = offsetPlane(planeXY(), dz / 2);

    try {
      const segs = sectionCurvesToPlaneSegments(oc, box, mid);
      // Rectangle: 4 edges.
      expect(segs.length).toBeGreaterThanOrEqual(4);
      // Total perimeter ≈ 2*(dx+dy).
      const perimeter = segs.reduce(
        (acc, s) => acc + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]),
        0,
      );
      expect(perimeter).toBeCloseTo(2 * (dx + dy), 6);
      // All UV points live in the box's XY footprint (allow tiny numeric slop).
      for (const s of segs) {
        for (const p of [s.a, s.b]) {
          expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
          expect(p[0]).toBeLessThanOrEqual(dx + 1e-9);
          expect(p[1]).toBeGreaterThanOrEqual(-1e-9);
          expect(p[1]).toBeLessThanOrEqual(dy + 1e-9);
        }
      }
    } finally {
      box.delete();
    }
  });

  it("YZ mid-section projects to plane YZ UV with correct perimeter", () => {
    const dx = mm(50);
    const dy = mm(30);
    const dz = mm(20);
    const box = makeBox(oc, dx, dy, dz);
    const mid = offsetPlane(planeYZ(), dx / 2);
    try {
      const segs = sectionCurvesToPlaneSegments(oc, box, mid);
      const perimeter = segs.reduce(
        (acc, s) => acc + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]),
        0,
      );
      // planeYZ: u along +Y, v along +Z → section is dy × dz rectangle.
      expect(perimeter).toBeCloseTo(2 * (dy + dz), 6);
    } finally {
      box.delete();
    }
  });

  it("rejects an ill-formed plane (named error from sectionCurves)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    try {
      expect(() =>
        sectionCurvesToPlaneSegments(oc, box, {
          origin: [0, 0, 0],
          normal: [0, 0, 0],
          xAxis: [1, 0, 0],
        }),
      ).toThrow(/sectionCurves: plane normal must be a non-zero vector/);
    } finally {
      box.delete();
    }
  });
});
