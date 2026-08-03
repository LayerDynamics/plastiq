// §16 Phase 4 — the sculpt brush set: determinism, strict locality (only cells within
// radius change), material buildup/removal, smoothing lowers variance, and mirror symmetry.

import { describe, expect, it } from "vitest";

import { SdfGrid } from "./sdf.js";
import { applyBrushToDoc, applyBrushToSdf, falloffWeight, type BrushSpec } from "./brushes.js";

function ball(): SdfGrid {
  return SdfGrid.sphere([24, 24, 24], 0.01, [-0.12, -0.12, -0.12], [0, 0, 0], 0.1);
}

describe("falloffWeight", () => {
  it("is 1 at the centre and 0 at/after the rim for every profile", () => {
    for (const k of ["smooth", "linear", "constant"] as const) {
      expect(falloffWeight(0, 1, k)).toBeCloseTo(1, 6);
      expect(falloffWeight(1, 1, k)).toBe(0);
      expect(falloffWeight(1.5, 1, k)).toBe(0);
    }
  });
});

describe("brush locality + determinism", () => {
  it("draw only changes cells within the radius, and is deterministic", () => {
    const base = ball().toDoc();
    // Centre the brush ON the surface (radius 0.1) so a deposit actually lands.
    const spec: BrushSpec = { type: "draw", center: [0.1, 0, 0], radius: 0.03, strength: 0.9 };
    const a = applyBrushToDoc(base, spec);
    const b = applyBrushToDoc(base, spec);
    // deterministic
    expect(a.sdf!.field).toEqual(b.sdf!.field);

    // locality: any cell whose CENTRE is outside the radius is unchanged.
    const g = SdfGrid.sphere([24, 24, 24], 0.01, [-0.12, -0.12, -0.12], [0, 0, 0], 0.1);
    const before = base.sdf!.field;
    const after = a.sdf!.field;
    let changed = 0;
    for (let z = 0; z < 24; z++)
      for (let y = 0; y < 24; y++)
        for (let x = 0; x < 24; x++) {
          const i = g.idx(x, y, z);
          const p = g.world(x, y, z);
          const d = Math.hypot(p[0] - 0.1, p[1], p[2]);
          if (d >= 0.03) {
            expect(after[i]).toBe(before[i]); // strictly local
          } else if (after[i] !== before[i]) {
            changed++;
          }
        }
    expect(changed).toBeGreaterThan(0); // something inside the radius moved
  });

  it("draw with positive strength adds material (grows the inside count)", () => {
    const base = ball().toDoc();
    const grown = applyBrushToDoc(base, { type: "draw", center: [0.1, 0, 0], radius: 0.04, strength: 0.9 });
    expect(grown.cells.length).toBeGreaterThan(base.cells.length);
  });

  it("draw with negative strength removes material (shrinks the inside count)", () => {
    const base = ball().toDoc();
    const carved = applyBrushToDoc(base, { type: "draw", center: [0, 0, 0.1], radius: 0.05, strength: -0.9 });
    expect(carved.cells.length).toBeLessThan(base.cells.length);
  });
});

describe("smooth brush", () => {
  it("reduces field variance within the brush region", () => {
    // Seed a noisy field.
    const g = SdfGrid.empty([20, 20, 20], 0.01, [-0.1, -0.1, -0.1], 0.1);
    let seed = 1;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    for (let i = 0; i < g.field.length; i++) g.field[i] = rand() * 0.05;

    const center: [number, number, number] = [0, 0, 0];
    const radius = 0.06;
    const region: number[] = [];
    for (let z = 0; z < 20; z++)
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++) {
          const p = g.world(x, y, z);
          if (Math.hypot(p[0], p[1], p[2]) < radius) region.push(g.idx(x, y, z));
        }
    const variance = (field: Float32Array): number => {
      const mean = region.reduce((s, i) => s + field[i]!, 0) / region.length;
      return region.reduce((s, i) => s + (field[i]! - mean) ** 2, 0) / region.length;
    };
    const before = variance(g.field);
    applyBrushToSdf(g, { type: "smooth", center, radius, strength: 1, falloff: "constant" });
    const after = variance(g.field);
    expect(after).toBeLessThan(before);
  });
});

describe("mirror symmetry", () => {
  it("a mirrored draw brush affects both sides of the plane symmetrically", () => {
    const base = ball().toDoc();
    const mirrored = applyBrushToDoc(base, {
      type: "draw",
      center: [0.08, 0, 0],
      radius: 0.03,
      strength: 0.8,
      mirror: [{ axis: 0, coord: 0 }],
    });
    const g = SdfGrid.sphere([24, 24, 24], 0.01, [-0.12, -0.12, -0.12], [0, 0, 0], 0.1);
    // Sample the field at the brush centre and its mirror — both should have moved equally.
    const left = sampleAt(mirrored.sdf!.field, g, [0.08, 0, 0]);
    const right = sampleAt(mirrored.sdf!.field, g, [-0.08, 0, 0]);
    expect(left).toBeCloseTo(right, 5);
  });
});

function sampleAt(field: number[], g: SdfGrid, p: [number, number, number]): number {
  const s = g.voxelSize;
  const x = Math.round((p[0] - g.origin[0]) / s - 0.5);
  const y = Math.round((p[1] - g.origin[1]) / s - 0.5);
  const z = Math.round((p[2] - g.origin[2]) / s - 0.5);
  return field[g.idx(x, y, z)]!;
}
