// Real-OCCT tests for §13.2 heal + §14 sew/solidify.
//
// Coverage:
//   - sew two coplanar adjacent faces → shell; free bounds reported
//   - solidify a closed shell (box faces sewn) → solid with box volume
//   - heal on a solid (ShapeFix path) preserves volume; sewTolerance guards
//   - solidify rejects an open shell with a named free-edge error

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import { Solid } from "../solid/solid.js";
import { Sketch } from "../sketch/sketch.js";
import { planeXY } from "../env/plane.js";
import { analyzeFreeBounds, heal, sew, solidify } from "./heal.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Every face of a solid as owned Solid wrappers (caller must delete each + the box). */
function facesOf(box: Solid): Solid[] {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  const out: Solid[] = [];
  try {
    while (exp.More()) {
      out.push(new Solid(oc, oc.TopoDS.Face_1(exp.Current())));
      exp.Next();
    }
  } catch (e) {
    for (const f of out) f.delete();
    throw e;
  } finally {
    exp.delete();
  }
  return out;
}

/** A planar rectangle face on the XY plane as an owned Solid. */
function rectFace(x0: number, y0: number, x1: number, y1: number): Solid {
  // First lineTo sets the start; subsequent calls add segments; toFace auto-closes.
  const sk = new Sketch(planeXY());
  sk.lineTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1);
  return new Solid(oc, sk.toFace(oc));
}

describe("sew", () => {
  it("sews two coplanar adjacent faces into a shell and reports free bounds", () => {
    // Two 0.02×0.02 squares on XY sharing the edge x=0.02.
    const a = rectFace(0, 0, 0.02, 0.02);
    const b = rectFace(0.02, 0, 0.04, 0.02);
    const { shell, freeEdges } = sew(oc, [a, b], 1e-6);
    try {
      expect(shell.shape.IsNull()).toBe(false);
      // Open sheet: free edges remain (outer perimeter).
      expect(freeEdges.freeEdgeCount).toBeGreaterThan(0);
      // Sewing and FreeBounds should agree that this is NOT closed.
      expect(freeEdges.sewingFreeEdges).toBeGreaterThan(0);
      // At least one free wire describes the outer boundary.
      expect(freeEdges.closedFreeWires + freeEdges.openFreeWires).toBeGreaterThan(0);
      // Sewed shape is a shell (connected faces) — not a solid.
      const S = shapeEnums(oc);
      expect(shell.shape.ShapeType()).toBe(S.TopAbs_SHELL);
    } finally {
      shell.delete();
      a.delete();
      b.delete();
    }
  });

  it("rejects an empty face list and a non-positive tolerance with named errors", () => {
    expect(() => sew(oc, [], 1e-6)).toThrow(/sew: no faces to sew/);
    const a = rectFace(0, 0, 0.01, 0.01);
    try {
      expect(() => sew(oc, [a], 0)).toThrow(/sew: tolerance must be a finite positive number/);
      expect(() => sew(oc, [a], Number.NaN)).toThrow(/sew: tolerance must be a finite positive number/);
    } finally {
      a.delete();
    }
  });
});

describe("solidify", () => {
  it("solidifies a closed shell of box faces into a solid with the box volume", () => {
    const dx = 0.04;
    const dy = 0.03;
    const dz = 0.02;
    const box = makeBox(oc, dx, dy, dz);
    const faces = facesOf(box);
    const { shell, freeEdges } = sew(oc, faces, 1e-7);
    try {
      // Six box faces with coincident shared edges sew shut completely.
      expect(freeEdges.freeEdgeCount).toBe(0);
      expect(freeEdges.sewingFreeEdges).toBe(0);

      const solid = solidify(oc, shell);
      try {
        expect(solid.isValid()).toBe(true);
        expect(solid.volume()).toBeCloseTo(dx * dy * dz, 12);
        expect(solid.volume()).toBeGreaterThan(0);
        const S = shapeEnums(oc);
        expect(solid.shape.ShapeType()).toBe(S.TopAbs_SOLID);
      } finally {
        solid.delete();
      }
    } finally {
      shell.delete();
      for (const f of faces) f.delete();
      box.delete();
    }
  });

  it("rejects an open shell with a named free-edge error", () => {
    const face = rectFace(0, 0, 0.02, 0.01);
    const { shell, freeEdges } = sew(oc, [face], 1e-6);
    try {
      expect(freeEdges.freeEdgeCount).toBeGreaterThan(0);
      expect(() => solidify(oc, shell)).toThrow(/solidify: shell is not closed/);
    } finally {
      shell.delete();
      face.delete();
    }
  });
});

describe("heal", () => {
  it("runs ShapeFix on a solid and preserves volume", () => {
    const box = makeBox(oc, 0.03, 0.02, 0.01);
    const vol = box.volume();
    // Skip sew (already a solid) via non-positive sewTolerance; still ShapeFix.
    const healed = heal(oc, box, { sewTolerance: 0, fixSolid: true });
    try {
      expect(healed.shape.IsNull()).toBe(false);
      expect(healed.isValid()).toBe(true);
      expect(healed.volume()).toBeCloseTo(vol, 12);
    } finally {
      healed.delete();
      box.delete();
    }
  });

  it("heals a loose box-face compound (sew + ShapeFix) into a closed shell that solidifies", () => {
    // Slightly "broken" in the surface-pillar sense: six loose box faces that
    // need sewing before they form a solid. heal sews + ShapeFix; we then
    // solidify the result and check volume.
    const dx = 0.025;
    const dy = 0.02;
    const dz = 0.015;
    const box = makeBox(oc, dx, dy, dz);
    const faces = facesOf(box);
    const builder = new oc.BRep_Builder();
    const compound = new oc.TopoDS_Compound();
    try {
      builder.MakeCompound(compound);
      for (const f of faces) builder.Add(compound, f.shape);
    } finally {
      builder.delete();
    }
    const loose = new Solid(oc, compound);

    const healed = heal(oc, loose, { sewTolerance: 1e-6, fixSolid: false });
    try {
      const report = analyzeFreeBounds(oc, healed.shape);
      expect(report.freeEdgeCount).toBe(0);

      const solid = solidify(oc, healed);
      try {
        expect(solid.volume()).toBeCloseTo(dx * dy * dz, 9);
        expect(solid.isValid()).toBe(true);
      } finally {
        solid.delete();
      }
    } finally {
      healed.delete();
      loose.delete();
      for (const f of faces) f.delete();
      box.delete();
    }
  });

  it("rejects a non-finite positive sewTolerance with a named error", () => {
    const box = makeBox(oc, 0.01, 0.01, 0.01);
    try {
      expect(() => heal(oc, box, { sewTolerance: Number.NaN })).toThrow(
        /heal: sewTolerance must be finite/,
      );
      expect(() => heal(oc, box, { sewTolerance: Number.POSITIVE_INFINITY })).toThrow(
        /heal: sewTolerance must be finite/,
      );
    } finally {
      box.delete();
    }
  });
});
