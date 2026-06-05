import { beforeAll, describe, expect, it } from "vitest";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { draft } from "./draft.js";

const INIT_TIMEOUT_MS = 120_000;

describe("draft feature (FR-17)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("tapers a side face about a base neutral plane, removing material", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6 m³
    try {
      const drafted = draft(oc, box, {
        face: { normal: [1, 0, 0] }, // taper the +X face
        pullDirection: [0, 0, 1], // pull upward (+Z)
        neutralOrigin: [0, 0, 0], // base plane stays fixed
        neutralNormal: [0, 0, 1],
        angle: (5 * Math.PI) / 180, // 5°
      });
      try {
        expect(drafted.isValid()).toBe(true);
        const v = massProperties(oc, drafted, 1).volume;
        // The +X face leans inward toward the top → less than the full box,
        // but only a thin tapered wedge is removed.
        expect(v).toBeLessThan(8e-6);
        expect(v).toBeGreaterThan(7e-6);
      } finally {
        drafted.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("throws a typed error when the face reference is unresolvable", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      expect(() =>
        draft(oc, box, {
          face: { normal: [0.3, 0.3, 0.3] }, // matches no box face
          pullDirection: [0, 0, 1],
          neutralOrigin: [0, 0, 0],
          neutralNormal: [0, 0, 1],
          angle: 0.05,
        }),
      ).toThrow(/unresolvable/);
    } finally {
      box.delete();
    }
  });
});
