// buildSpineWire — UNIT (real OCCT): a polyline path builds an open wire; the
// degenerate guards (too few points, coincident points) throw.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { buildSpineWire, type SpinePath } from "./spine.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("buildSpineWire (unit)", () => {
  it("builds an open wire from a polyline of ≥2 distinct points", () => {
    const path: SpinePath = { kind: "polyline", points: [[0, 0, 0], [0.1, 0, 0], [0.1, 0.1, 0]] };
    const wire = buildSpineWire(oc, path);
    expect(wire.IsNull()).toBe(false);
    wire.delete();
  });

  it("throws on fewer than two points", () => {
    const path: SpinePath = { kind: "polyline", points: [[0, 0, 0]] };
    expect(() => buildSpineWire(oc, path)).toThrow(/at least two points/);
  });

  it("throws on a zero-length spine (all points coincide)", () => {
    const path: SpinePath = { kind: "polyline", points: [[0, 0, 0], [0, 0, 0]] };
    expect(() => buildSpineWire(oc, path)).toThrow(/zero-length/);
  });
});
