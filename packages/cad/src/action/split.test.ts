// Real-OCCT tests for split + sectionCurves (§13.2):
//   • box split by mid-plane → 2 solids, each half volume
//   • section of box by mid-plane → closed rectangle perimeter 2*(dx+dy)
// Plus binding pins for BRepAlgoAPI_Splitter / BRepAlgoAPI_Section (typeof is
// not enough under embind — construct them).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { Solid } from "../solid/solid.js";
import { shapeEnums } from "../mesh/normals.js";
import { offsetPlane, planeXY, planeYZ } from "../env/plane.js";
import { split, sectionCurves } from "./split.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Total edge length of a shape via BRepGProp.LinearProperties. */
function totalEdgeLength(shape: Solid["shape"]): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.LinearProperties(shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** Count TopAbs_EDGE children of a shape. */
function edgeCount(shape: Solid["shape"]): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
  let n = 0;
  try {
    while (exp.More()) {
      n++;
      exp.Next();
    }
  } finally {
    exp.delete();
  }
  return n;
}

describe("§13.2 binding pins — Splitter / Section construct", () => {
  it("BRepAlgoAPI_Splitter_1 is bound AND constructs", () => {
    expect(typeof oc.BRepAlgoAPI_Splitter_1).toBe("function");
    // typeof is NOT proof under embind (bindings.test.ts). Construct it.
    const op = new oc.BRepAlgoAPI_Splitter_1();
    expect(op).toBeDefined();
    expect(typeof op.SetTools).toBe("function");
    expect(typeof op.SetArguments).toBe("function");
    expect(typeof op.SetFuzzyValue).toBe("function");
    expect(typeof op.SetNonDestructive).toBe("function");
    op.delete();
  });

  it("BRepAlgoAPI_Section_5 is bound AND constructs (shape × plane, PerformNow=false)", () => {
    expect(typeof oc.BRepAlgoAPI_Section_5).toBe("function");
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const p = new oc.gp_Pnt_3(0, 0, mm(5));
    const d = new oc.gp_Dir_4(0, 0, 1);
    const pln = new oc.gp_Pln_3(p, d);
    try {
      const op = new oc.BRepAlgoAPI_Section_5(box.shape, pln, false);
      expect(op).toBeDefined();
      expect(typeof op.SetFuzzyValue).toBe("function");
      op.delete();
    } finally {
      pln.delete();
      d.delete();
      p.delete();
      box.delete();
    }
  });
});

describe("split", () => {
  it("box split by mid-plane → 2 solids, each half the original volume", () => {
    const dx = mm(60);
    const dy = mm(40);
    const dz = mm(30);
    const box = makeBox(oc, dx, dy, dz);
    // Box spans z ∈ [0, dz]; mid-plane is z = dz/2.
    const mid = offsetPlane(planeXY(), dz / 2);

    const parts = split(oc, box, mid);
    try {
      expect(parts).toHaveLength(2);
      const half = (dx * dy * dz) / 2;
      const v0 = parts[0]!.volume();
      const v1 = parts[1]!.volume();
      expect(v0).toBeCloseTo(half, 12);
      expect(v1).toBeCloseTo(half, 12);
      expect(v0 + v1).toBeCloseTo(box.volume(), 12);
      expect(parts[0]!.isValid()).toBe(true);
      expect(parts[1]!.isValid()).toBe(true);
      // Operands survive (NonDestructive).
      expect(box.volume()).toBeCloseTo(dx * dy * dz, 12);
    } finally {
      for (const p of parts) p.delete();
      box.delete();
    }
  });

  it("splits a box with a Solid knife body (through-cut keeps both lumps)", () => {
    // A thin slab through the middle of a bar — same geometry as the boolean
    // lumps=2 case, but split keeps material on both sides of the tool skin
    // (unlike subtract, which would remove the knife volume).
    const bar = makeBox(oc, mm(60), mm(10), mm(10));
    // Mid-plane face of a thin cutting solid: a face-only tool is also accepted.
    // Use a solid knife that fully crosses the bar in Y and Z at x = 30.
    const knife = makeBoxAt(oc, [mm(29), -mm(5), -mm(5)], mm(2), mm(20), mm(20));

    // Prefer a plane tool for the canonical keep-both split; Solid body tools
    // split along the tool's boundary surfaces. A face extracted from the knife
    // mid-plane is a cleaner Solid-tool path than the whole knife body.
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(knife.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    // Walk to a face roughly normal to +X (the cutting face).
    let faceTool: Solid | null = null;
    try {
      while (exp.More()) {
        const f = oc.TopoDS.Face_1(exp.Current());
        // Use the first face as the tool — a face Solid is an accepted SplitTool.
        faceTool = new Solid(oc, f);
        break;
      }
    } finally {
      exp.delete();
    }
    expect(faceTool).not.toBeNull();

    const parts = split(oc, bar, faceTool!);
    try {
      // A planar face through the bar yields two solid lumps.
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const total = parts.reduce((s, p) => s + p.volume(), 0);
      // Face split keeps all material (no cut volume removed).
      expect(total).toBeCloseTo(bar.volume(), 9);
    } finally {
      for (const p of parts) p.delete();
      faceTool!.delete();
      knife.delete();
      bar.delete();
    }
  });

  it("splits by a plane normal to X (mid of a 60 mm bar)", () => {
    const dx = mm(60);
    const dy = mm(20);
    const dz = mm(10);
    const box = makeBox(oc, dx, dy, dz);
    const mid = offsetPlane(planeYZ(), dx / 2);

    const parts = split(oc, box, mid);
    try {
      expect(parts).toHaveLength(2);
      const half = (dx * dy * dz) / 2;
      expect(parts[0]!.volume()).toBeCloseTo(half, 12);
      expect(parts[1]!.volume()).toBeCloseTo(half, 12);
    } finally {
      for (const p of parts) p.delete();
      box.delete();
    }
  });

  it("rejects a non-finite or zero plane normal with a named error, before OCCT work", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    try {
      expect(() =>
        split(oc, box, { origin: [0, 0, 0], normal: [0, 0, 0], xAxis: [1, 0, 0] }),
      ).toThrow(/split: plane normal must be a non-zero vector/);
      expect(() =>
        split(oc, box, {
          origin: [Number.NaN, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
        }),
      ).toThrow(/split: plane origin must be a finite point/);
    } finally {
      box.delete();
    }
  });
});

describe("sectionCurves", () => {
  it("section of a box by mid-plane → closed rectangle perimeter 2*(dx+dy)", () => {
    const dx = mm(60);
    const dy = mm(40);
    const dz = mm(30);
    const box = makeBox(oc, dx, dy, dz);
    // Mid-plane z = dz/2 cuts a dx × dy rectangle.
    const mid = offsetPlane(planeXY(), dz / 2);

    const section = sectionCurves(oc, box, mid);
    try {
      const perimeter = totalEdgeLength(section.shape);
      expect(perimeter).toBeCloseTo(2 * (dx + dy), 9);
      // Four edges of a rectangle (OCCT may report 4 edges for the closed loop).
      expect(edgeCount(section.shape)).toBeGreaterThanOrEqual(4);
      // Body survives (NonDestructive).
      expect(box.volume()).toBeCloseTo(dx * dy * dz, 12);
    } finally {
      section.delete();
      box.delete();
    }
  });

  it("section of a box by a YZ mid-plane → perimeter 2*(dy+dz)", () => {
    const dx = mm(50);
    const dy = mm(30);
    const dz = mm(20);
    const box = makeBox(oc, dx, dy, dz);
    const mid = offsetPlane(planeYZ(), dx / 2);

    const section = sectionCurves(oc, box, mid);
    try {
      expect(totalEdgeLength(section.shape)).toBeCloseTo(2 * (dy + dz), 9);
    } finally {
      section.delete();
      box.delete();
    }
  });

  it("rejects an ill-formed plane with a named error", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    try {
      expect(() =>
        sectionCurves(oc, box, {
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
