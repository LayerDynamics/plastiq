// filletLaw — FablesFindings §13.2.
//
// Status of the continuous-law route (measured, not assumed):
//   - Law_Linear constructs; Set / Value work from JS.
//   - Handle_Law_Function_2 wraps a Law_Linear.
//   - MakeFillet.Add_4 accepts that handle (NbContours becomes 1).
//   - MakeFillet.Shape() then raises Standard_Failure for EVERY law tried
//     (linear variable, constant radius) — so law-driven fillet geometry is
//     uncallable through this embind build.
//   - Discrete two-radius via Add_3 (fillet endRadius / filletLaw) works.
//
// filletLaw therefore delivers the Add_3 approximation; the pins below keep
// both facts from regressing silently.

import { beforeAll, describe, expect, it } from "vitest";

import type { ChFi3d_FilletShape } from "opencascade.js";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { resolveEdgeRef } from "../mesh/resolve.js";
import type { EdgeRef } from "../mesh/tagged.js";
import { isRawOcctFailure } from "../oc/error.js";
import { fillet, filletLaw } from "./dressup.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function oneEdge(dx: number, dy: number, dz: number): EdgeRef {
  const box = makeBox(oc, dx, dy, dz);
  const mesh = tessellateTagged(oc, box);
  const edge: EdgeRef = { faceNormals: mesh.edges[0]!.faceNormals };
  box.delete();
  return edge;
}

describe("filletLaw — Law_* pin (constructible, unusable for Shape)", () => {
  it("Law_Linear constructs and evaluates from JS", () => {
    expect(typeof oc.Law_Linear).toBe("function");
    expect(typeof oc.Handle_Law_Function_2).toBe("function");

    // Handle_Law_Function_2 takes ownership of the Law_Linear — free only the
    // handle (a second law.delete() double-frees and crashes the wasm destructor).
    const law = new oc.Law_Linear();
    law.Set(0, 0.002, 1, 0.005);
    expect(law.Value(0)).toBeCloseTo(0.002, 12);
    expect(law.Value(1)).toBeCloseTo(0.005, 12);
    expect(law.Value(0.5)).toBeCloseTo(0.0035, 12);

    const handle = new oc.Handle_Law_Function_2(law);
    try {
      expect(handle.IsNull()).toBe(false);
      expect(handle.get().Value(0)).toBeCloseTo(0.002, 12);
    } finally {
      handle.delete();
    }
  });

  it("MakeFillet.Add_4 + Shape() fails even with a constant Law_Linear (uncallable)", () => {
    // Proves the continuous-law fillet path cannot deliver geometry today: Add_4
    // registers the contour, but the build throws Standard_Failure. Constant
    // radius rules out "radius too large" as the cause — Add_2(3mm) on the same
    // edge succeeds (see dressup tests); only the law route fails.
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    const edge = resolveEdgeRef(oc, box, {
      faceNormals: mesh.edges[0]!.faceNormals,
    })!;
    const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
    const maker = new oc.BRepFilletAPI_MakeFillet(box.shape, shapeType);
    const law = new oc.Law_Linear();
    law.Set(0, mm(3), 1, mm(3));
    const handle = new oc.Handle_Law_Function_2(law);
    try {
      maker.Add_4(handle, edge);
      expect(maker.NbContours()).toBe(1);
      let threw: unknown;
      try {
        const shape = maker.Shape();
        // If Shape ever starts succeeding, this pin must be rewritten — law
        // fillet would then be the real delivery path for filletLaw.
        shape.delete();
        threw = null;
      } catch (e) {
        threw = e;
      }
      expect(threw, "expected MakeFillet.Shape() after Add_4(Law) to fail").not.toBeNull();
      expect(isRawOcctFailure(threw) || threw instanceof Error).toBe(true);
    } finally {
      handle.delete();
      maker.delete();
      edge.delete();
      box.delete();
    }
  });
});

describe("filletLaw — discrete Add_3 delivery", () => {
  it("produces a valid solid (Add_3 two-radius approximation)", () => {
    const edge = oneEdge(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const result = filletLaw(oc, box, [edge], {
      startRadius: mm(2),
      endRadius: mm(5),
    });
    expect(result.isValid()).toBe(true);
    expect(result.volume()).toBeLessThan(box.volume());
    expect(result.volume()).toBeGreaterThan(0);
    result.delete();
    box.delete();
  });

  it("matches fillet(…, { endRadius }) on the same inputs", () => {
    const edge = oneEdge(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const viaLaw = filletLaw(oc, box, [edge], {
      startRadius: mm(2),
      endRadius: mm(5),
    });
    const viaOpts = fillet(oc, box, [edge], mm(2), { endRadius: mm(5) });
    expect(viaLaw.volume()).toBeCloseTo(viaOpts.volume(), 12);
    viaLaw.delete();
    viaOpts.delete();
    box.delete();
  });

  it("rejects non-positive radii", () => {
    const edge = oneEdge(mm(40), mm(40), mm(40));
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    expect(() =>
      filletLaw(oc, box, [edge], { startRadius: 0, endRadius: mm(2) }),
    ).toThrow(/startRadius/);
    expect(() =>
      filletLaw(oc, box, [edge], { startRadius: mm(2), endRadius: -1 }),
    ).toThrow(/endRadius/);
    box.delete();
  });
});
