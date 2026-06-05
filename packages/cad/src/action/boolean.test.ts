import { beforeAll, describe, expect, it } from "vitest";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import { mm } from "../unit/index.js";
import { intersect, subtract, union } from "./boolean.js";

const INIT_TIMEOUT_MS = 120_000;

function volume(oc: Occt, s: Solid): number {
  return massProperties(oc, s, 1).volume;
}
function rel(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

describe("boolean operations (FR-7)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  // A: [0,0.02]³ (8e-6). B: corner (0.01,0.01,0.01), same size → overlap [0.01,0.02]³ = 1e-6.
  const buildPair = () => ({
    a: makeBox(oc, mm(20), mm(20), mm(20)),
    b: makeBoxAt(oc, [mm(10), mm(10), mm(10)], mm(20), mm(20), mm(20)),
  });

  it("union volume = a + b − overlap", () => {
    const { a, b } = buildPair();
    try {
      const r = union(oc, a, b);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(rel(volume(oc, r.solid), 8e-6 + 8e-6 - 1e-6)).toBeLessThan(1e-9);
        r.solid.delete();
      }
    } finally {
      a.delete();
      b.delete();
    }
  });

  it("subtract volume = a − overlap", () => {
    const { a, b } = buildPair();
    try {
      const r = subtract(oc, a, b);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(rel(volume(oc, r.solid), 8e-6 - 1e-6)).toBeLessThan(1e-9);
        r.solid.delete();
      }
    } finally {
      a.delete();
      b.delete();
    }
  });

  it("intersect volume = overlap", () => {
    const { a, b } = buildPair();
    try {
      const r = intersect(oc, a, b);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(rel(volume(oc, r.solid), 1e-6)).toBeLessThan(1e-9);
        r.solid.delete();
      }
    } finally {
      a.delete();
      b.delete();
    }
  });

  it("intersect of disjoint solids returns a typed empty-result error (no throw, NFR-3)", () => {
    const a = makeBox(oc, mm(10), mm(10), mm(10));
    const b = makeBoxAt(oc, [1, 1, 1], mm(10), mm(10), mm(10)); // 1 m away → disjoint
    try {
      const r = intersect(oc, a, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("empty");
    } finally {
      a.delete();
      b.delete();
    }
  });
});
