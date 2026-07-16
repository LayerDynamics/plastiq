// revolve / rotate / mirror failure-path hardening — UNIT (fake kernel).
//
// Two disciplines, matching action/cleanup.unit.test.ts:
//  1. A zero (or non-finite) axis/normal is rejected BEFORE any OCCT temporary
//     exists — gp_Dir_4 would otherwise raise an opaque Standard_Failure after
//     `face`/`o`/`trsf` were allocated, leaking them.
//  2. A Standard_Failure from a later OCCT constructor (MakeRevol, gp_Ax1) still
//     frees every temporary made so far (try/finally), and a null Shape() handle
//     is freed before the throw.

import { beforeEach, describe, expect, it } from "vitest";

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { revolve } from "./revolve.js";
import { mirror, rotate } from "./transform.js";

let deleted: string[];
const del = (label: string) => () => deleted.push(label);
/** A fake `Shape()` handle that reports null and records its own free as "shape". */
const nullShape = (): { IsNull: () => boolean; delete: () => void } => ({
  IsNull: () => true,
  delete: del("shape"),
});
const fakeSolid = (): Solid => ({ shape: {} }) as unknown as Solid;

beforeEach(() => {
  deleted = [];
});

describe("revolve validates its inputs before allocating", () => {
  // A sketch whose toFace must never run: if revolve allocated before
  // validating, this would throw its own message instead of the axis one.
  const untouchableSketch = {
    toFace: () => {
      throw new Error("toFace must not be called before validation");
    },
  } as unknown as Sketch;

  it("rejects a zero axis with nothing allocated (empty kernel, untouched sketch)", () => {
    expect(() =>
      revolve({} as unknown as Occt, untouchableSketch, [0, 0, 0], [0, 0, 0], Math.PI),
    ).toThrow(/axis/);
    expect(deleted).toEqual([]);
  });

  it("rejects a NaN axis the same way", () => {
    expect(() =>
      revolve({} as unknown as Occt, untouchableSketch, [0, 0, 0], [Number.NaN, 0, 0], Math.PI),
    ).toThrow(/axis/);
  });

  it("still rejects a zero angle first", () => {
    expect(() =>
      revolve({} as unknown as Occt, untouchableSketch, [0, 0, 0], [0, 0, 1], 0),
    ).toThrow(/angle/);
  });
});

describe("revolve frees its temporaries on the failure paths", () => {
  const sketch = { toFace: () => ({ delete: del("face") }) } as unknown as Sketch;
  const gpOc = (overrides: Record<string, unknown>): Occt =>
    ({
      gp_Pnt_3: function () {
        return { delete: del("o") };
      },
      gp_Dir_4: function () {
        return { delete: del("d") };
      },
      gp_Ax1_2: function () {
        return { delete: del("ax") };
      },
      ...overrides,
    }) as unknown as Occt;

  it("frees face and the gp_* temporaries when MakeRevol throws a Standard_Failure", () => {
    const oc = gpOc({
      BRepPrimAPI_MakeRevol_1: function () {
        throw new Error("Standard_Failure: the profile crosses the axis");
      },
    });
    expect(() => revolve(oc, sketch, [0, 0, 0], [0, 0, 1], Math.PI)).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["face", "o", "d", "ax"]));
  });

  it("frees the null Shape() handle (plus maker/face/gp_*) on the empty-shape throw", () => {
    const oc = gpOc({
      BRepPrimAPI_MakeRevol_1: function () {
        return { Shape: () => nullShape(), delete: del("rev") };
      },
    });
    expect(() => revolve(oc, sketch, [0, 0, 0], [0, 0, 1], Math.PI)).toThrow(/empty shape/);
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["rev", "ax", "d", "o", "face"]));
  });

  it("on success frees the temporaries but hands the shape to the Solid", () => {
    const kept = { IsNull: () => false, delete: del("SHAPE-KEPT") };
    const oc = gpOc({
      BRepPrimAPI_MakeRevol_1: function () {
        return { Shape: () => kept, delete: del("rev") };
      },
    });
    const solid = revolve(oc, sketch, [0, 0, 0], [0, 0, 1], Math.PI);
    expect(solid.shape).toBe(kept);
    expect(deleted).toEqual(expect.arrayContaining(["rev", "ax", "d", "o", "face"]));
    expect(deleted).not.toContain("SHAPE-KEPT");
  });
});

describe("rotate validates the axis and cleans up on a mid-build throw", () => {
  it("rejects a zero axis with nothing allocated", () => {
    expect(() => rotate({} as unknown as Occt, fakeSolid(), [0, 0, 0], [0, 0, 0], 1)).toThrow(
      /axis/,
    );
    expect(deleted).toEqual([]);
  });

  it("rejects a non-finite axis", () => {
    expect(() =>
      rotate({} as unknown as Occt, fakeSolid(), [0, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], 1),
    ).toThrow(/axis/);
  });

  it("frees trsf and o when gp_Dir_4 throws a Standard_Failure", () => {
    const oc = {
      gp_Trsf_1: function () {
        return { SetRotation_1: () => {}, delete: del("trsf") };
      },
      gp_Pnt_3: function () {
        return { delete: del("o") };
      },
      gp_Dir_4: function () {
        throw new Error("Standard_Failure: gp_Dir() - input vector has zero norm");
      },
    } as unknown as Occt;
    expect(() => rotate(oc, fakeSolid(), [0, 0, 0], [1, 0, 0], 1)).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["trsf", "o"]));
  });

  it("on success frees the gp_* temporaries but not the result shape", () => {
    const out = { delete: del("OUT-SHAPE") };
    const oc = {
      gp_Trsf_1: function () {
        return { SetRotation_1: () => {}, delete: del("trsf") };
      },
      gp_Pnt_3: function () {
        return { delete: del("o") };
      },
      gp_Dir_4: function () {
        return { delete: del("d") };
      },
      gp_Ax1_2: function () {
        return { delete: del("ax") };
      },
      BRepBuilderAPI_Transform_2: function () {
        return { Shape: () => out, delete: del("t") };
      },
    } as unknown as Occt;
    const solid = rotate(oc, fakeSolid(), [0, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(solid.shape).toBe(out);
    expect(deleted).toEqual(expect.arrayContaining(["trsf", "o", "d", "ax", "t"]));
    expect(deleted).not.toContain("OUT-SHAPE");
  });
});

describe("mirror validates the normal and cleans up on a mid-build throw", () => {
  it("rejects a zero normal with nothing allocated", () => {
    expect(() => mirror({} as unknown as Occt, fakeSolid(), [0, 0, 0], [0, 0, 0])).toThrow(
      /normal/,
    );
    expect(deleted).toEqual([]);
  });

  it("frees trsf and o when gp_Dir_4 throws a Standard_Failure", () => {
    const oc = {
      gp_Trsf_1: function () {
        return { SetMirror_3: () => {}, delete: del("trsf") };
      },
      gp_Pnt_3: function () {
        return { delete: del("o") };
      },
      gp_Dir_4: function () {
        throw new Error("Standard_Failure: gp_Dir() - input vector has zero norm");
      },
    } as unknown as Occt;
    expect(() => mirror(oc, fakeSolid(), [0, 0, 0], [1, 0, 0])).toThrow(/Standard_Failure/);
    expect(deleted).toEqual(expect.arrayContaining(["trsf", "o"]));
  });
});
