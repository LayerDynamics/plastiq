import { beforeAll, describe, expect, it } from "vitest";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import { mm } from "../unit/index.js";
import { chamfer } from "./chamfer.js";
import { fillet, filletVariable } from "./fillet.js";
import type { EdgeRef } from "./selection.js";

const INIT_TIMEOUT_MS = 120_000;

// The top-front edge of an axis-aligned box: adjacent to the +Z and +X faces.
const TOP_FRONT_EDGE: EdgeRef = {
  faceNormals: [
    [0, 0, 1],
    [1, 0, 0],
  ],
};

function volume(oc: Occt, s: Solid): number {
  return massProperties(oc, s, 1).volume;
}

describe("fillet + chamfer on persistent selections (FR-8 / FR-9)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("constant-radius fillet rounds an edge and reduces volume", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6
    try {
      const rounded = fillet(oc, box, [TOP_FRONT_EDGE], mm(3));
      try {
        expect(rounded.isValid()).toBe(true);
        const v = volume(oc, rounded);
        expect(v).toBeLessThan(8e-6); // material removed by the round-over
        expect(v).toBeGreaterThan(7e-6); // but only a small wedge
      } finally {
        rounded.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("variable-radius fillet is valid", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const rounded = filletVariable(oc, box, TOP_FRONT_EDGE, mm(1), mm(4));
      try {
        expect(rounded.isValid()).toBe(true);
      } finally {
        rounded.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("chamfer bevels an edge and reduces volume", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const beveled = chamfer(oc, box, [TOP_FRONT_EDGE], mm(3));
      try {
        expect(beveled.isValid()).toBe(true);
        expect(volume(oc, beveled)).toBeLessThan(8e-6);
      } finally {
        beveled.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("CRITICAL (R2): the same named fillet applies after an upstream rebuild", () => {
    // The fillet targets a logical edge by signature, not a raw handle — so it
    // re-applies to the correct edge when the box is rebuilt at a new height.
    const original = makeBox(oc, mm(20), mm(20), mm(20));
    const rebuilt = makeBox(oc, mm(20), mm(20), mm(50)); // upstream "height" changed
    try {
      const a = fillet(oc, original, [TOP_FRONT_EDGE], mm(3));
      const b = fillet(oc, rebuilt, [TOP_FRONT_EDGE], mm(3));
      try {
        expect(a.isValid()).toBe(true);
        expect(b.isValid()).toBe(true);
        // The rebuilt (taller) part has more volume than the original, both filleted.
        expect(volume(oc, b)).toBeGreaterThan(volume(oc, a));
      } finally {
        a.delete();
        b.delete();
      }
    } finally {
      original.delete();
      rebuilt.delete();
    }
  });

  it("throws a typed error when the edge reference is unresolvable", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const impossible: EdgeRef = {
        faceNormals: [
          [0, 0, 1],
          [0, 0, -1],
        ],
      };
      expect(() => fillet(oc, box, [impossible], mm(2))).toThrow(/unresolvable/);
    } finally {
      box.delete();
    }
  });
});
