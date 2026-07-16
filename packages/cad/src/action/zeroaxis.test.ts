// Zero-axis validation — REAL OCCT wasm. revolve/rotate/mirror must reject a
// zero (or non-finite) axis/normal with a clear Error of their own BEFORE OCCT
// raises an opaque Standard_Failure from gp_Dir — and the valid-input paths
// must be untouched by the try/finally hardening (the result shape survives
// the temporaries' cleanup).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { revolve } from "./revolve.js";
import { mirror, rotate } from "./transform.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** A rectangular profile on XZ, offset from the axis, for revolve. */
function annulusProfile(): Sketch {
  const sk = new Sketch(planeXZ());
  sk.lineTo(mm(10), 0);
  sk.lineTo(mm(20), 0);
  sk.lineTo(mm(20), mm(30));
  sk.lineTo(mm(10), mm(30));
  return sk;
}

describe("zero-axis inputs fail loud with a kernel-level Error", () => {
  it("revolve rejects a zero axis", () => {
    expect(() => revolve(oc, annulusProfile(), [0, 0, 0], [0, 0, 0], Math.PI)).toThrow(
      /revolve: axis/,
    );
  });

  it("revolve rejects a NaN axis", () => {
    expect(() =>
      revolve(oc, annulusProfile(), [0, 0, 0], [Number.NaN, 0, 0], Math.PI),
    ).toThrow(/revolve: axis/);
  });

  it("rotate rejects a zero axis", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    expect(() => rotate(oc, box, [0, 0, 0], [0, 0, 0], Math.PI / 2)).toThrow(/rotate: axis/);
    box.delete();
  });

  it("mirror rejects a zero plane normal", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    expect(() => mirror(oc, box, [0, 0, 0], [0, 0, 0])).toThrow(/mirror: plane normal/);
    box.delete();
  });
});

describe("valid inputs still produce owned, live results after the hardening", () => {
  it("a full revolve still builds a solid of the right volume", () => {
    const solid = revolve(oc, annulusProfile(), [0, 0, 0], [0, 0, 1], 2 * Math.PI);
    // Annulus r=10..20 mm, h=30 mm: V = π(R²−r²)h.
    const expected = Math.PI * (mm(20) ** 2 - mm(10) ** 2) * mm(30);
    expect(solid.volume()).toBeCloseTo(expected, 9);
    expect(solid.isValid()).toBe(true);
    solid.delete();
  });

  it("rotate preserves the solid (volume) and returns an independent copy", () => {
    const box = makeBox(oc, mm(10), mm(20), mm(30));
    const rotated = rotate(oc, box, [0, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(rotated.volume()).toBeCloseTo(box.volume(), 12);
    box.delete(); // Copy=true: the rotated solid survives deleting the input
    expect(rotated.isValid()).toBe(true);
    rotated.delete();
  });

  it("mirror preserves the solid (volume) and returns an independent copy", () => {
    const box = makeBox(oc, mm(10), mm(20), mm(30));
    const mirrored = mirror(oc, box, [0, 0, 0], [1, 0, 0]);
    expect(mirrored.volume()).toBeCloseTo(box.volume(), 12);
    box.delete();
    expect(mirrored.isValid()).toBe(true);
    mirrored.delete();
  });
});
