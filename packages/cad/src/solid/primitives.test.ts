import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { massProperties } from "../lower/massprops.js";
import { tessellate } from "../mesh/tessellate.js";
import { mm } from "../unit/index.js";
import { makeBox } from "./primitives.js";

const INIT_TIMEOUT_MS = 120_000;

/** Relative closeness for exact-primitive quantities (NFR-1: ≤ 1e-9 rel). */
function relClose(actual: number, expected: number, rel = 1e-9): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(rel);
}

describe("box mass properties + tessellation (FR-25 / FR-3)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  // 10×20×30 mm aluminium box → SI 0.01 × 0.02 × 0.03 m.
  const A = mm(10);
  const B = mm(20);
  const C = mm(30);
  const DENSITY = 2700; // kg/m³

  it("box is valid", () => {
    const s = makeBox(oc, A, B, C);
    try {
      expect(s.isValid()).toBe(true);
    } finally {
      s.delete();
    }
  });

  it("mass properties match the analytic box within 1e-9 relative (NFR-1)", () => {
    const s = makeBox(oc, A, B, C);
    try {
      const mp = massProperties(oc, s, DENSITY);

      relClose(mp.volume, A * B * C); // 6e-6 m³
      relClose(mp.mass, DENSITY * A * B * C); // 0.0162 kg

      // COM at the box centre.
      relClose(mp.com[0], A / 2);
      relClose(mp.com[1], B / 2);
      relClose(mp.com[2], C / 2);

      // Inertia about COM: I = m·(sum of the two other half-dims²)/12.
      const m = DENSITY * A * B * C;
      const ixx = (m * (B * B + C * C)) / 12;
      const iyy = (m * (A * A + C * C)) / 12;
      const izz = (m * (A * A + B * B)) / 12;
      relClose(mp.inertia[0], ixx);
      relClose(mp.inertia[4], iyy);
      relClose(mp.inertia[8], izz);
      // Off-diagonals vanish for an axis-aligned box.
      for (const k of [1, 2, 3, 5, 6, 7]) {
        expect(Math.abs(mp.inertia[k] as number)).toBeLessThan(1e-15);
      }
    } finally {
      s.delete();
    }
  });

  it("tessellates to a non-empty, finite, triangle-divisible mesh (FR-3)", () => {
    const s = makeBox(oc, A, B, C);
    try {
      const mesh = tessellate(oc, s, { linearDeflection: mm(0.1) });
      expect(mesh.indices.length).toBeGreaterThan(0);
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.vertices.length % 3).toBe(0);
      expect(mesh.vertices.every((v) => Number.isFinite(v))).toBe(true);
      // Every index addresses a real vertex.
      const nVerts = mesh.vertices.length / 3;
      expect(mesh.indices.every((i) => Number.isInteger(i) && i >= 0 && i < nVerts)).toBe(true);
    } finally {
      s.delete();
    }
  });
});
