import { beforeAll, describe, expect, it } from "vitest";

import { translate } from "../action/transform.js";
import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "./primitives.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("Solid.distanceTo — exact B-rep distance (§13.2)", () => {
  it("returns the exact gap and closest kernel points for separated solids", () => {
    const a = makeBox(oc, mm(20), mm(20), mm(20));
    const b = translate(oc, a, [mm(30), mm(4), mm(3)]);
    try {
      const result = a.distanceTo(b);
      expect(result.distance).toBeCloseTo(mm(10), 10);
      expect(result.inner).toBe(false);
      expect(result.points[0][0]).toBeCloseTo(mm(20), 10);
      expect(result.points[1][0]).toBeCloseTo(mm(30), 10);
      expect(result.points[0][1]).toBeCloseTo(result.points[1][1], 10);
      expect(result.points[0][2]).toBeCloseTo(result.points[1][2], 10);
    } finally {
      b.delete();
      a.delete();
    }
  });

  it("reports zero separation for intersecting solids", () => {
    const a = makeBox(oc, mm(20), mm(20), mm(20));
    const b = translate(oc, a, [mm(10), 0, 0]);
    try {
      expect(a.distanceTo(b).distance).toBeCloseTo(0, 12);
    } finally {
      b.delete();
      a.delete();
    }
  });
});
