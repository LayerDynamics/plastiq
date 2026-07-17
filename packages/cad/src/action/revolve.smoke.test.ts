// action/revolve — SMOKE (real OCCT): an axis-offset profile revolved 360° about Z
// yields a positive-volume solid of revolution. Exact volume is in features.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { revolve } from "./revolve.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("revolve — smoke", () => {
  it("revolves an offset rectangle about the Z axis into a ring solid", () => {
    const sk = new Sketch(planeXZ()); // offset from the axis (u ≥ 20mm)
    sk.lineTo(mm(20), 0).lineTo(mm(40), 0).lineTo(mm(40), mm(20)).lineTo(mm(20), mm(20));
    const solid = revolve(oc, sk, [0, 0, 0], [0, 0, 1], 2 * Math.PI);
    expect(solid.volume()).toBeGreaterThan(0);
    solid.delete();
  });

  // §4.8 N6 — OCCT's MakeRevol takes the angle modulo 2π WITHOUT warning, so a 3π
  // request used to produce exactly a HALF turn's volume as a "valid" solid.
  // A full turn (2π) is still accepted; anything past it fails loudly.
  it("accepts a full turn but rejects an angle past it (the silent mod-2π wrap)", () => {
    const profile = (): Sketch => {
      const sk = new Sketch(planeXZ());
      sk.lineTo(mm(20), 0).lineTo(mm(40), 0).lineTo(mm(40), mm(20)).lineTo(mm(20), mm(20));
      return sk;
    };
    // 2π is a full, valid revolution.
    const full = revolve(oc, profile(), [0, 0, 0], [0, 0, 1], 2 * Math.PI);
    expect(full.volume()).toBeGreaterThan(0);
    full.delete();
    // 3π would have SILENTLY wrapped to π (half a turn) — now it throws.
    expect(() => revolve(oc, profile(), [0, 0, 0], [0, 0, 1], 3 * Math.PI)).toThrow(
      /exceeds a full turn/,
    );
    // A negative full turn is still legal (revolves the other way, §4.9).
    const neg = revolve(oc, profile(), [0, 0, 0], [0, 0, 1], -2 * Math.PI);
    expect(neg.volume()).toBeGreaterThan(0);
    neg.delete();
  });
});
