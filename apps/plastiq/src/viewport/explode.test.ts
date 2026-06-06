import { describe, expect, it } from "vitest";
import { explodeInstances, type RenderInstance } from "./explode.js";

const inst = (id: string, x: number, y = 0, z = 0): RenderInstance => ({
  id,
  position: [x, y, z],
  orientation: [0, 0, 0, 1],
});

describe("explodeInstances — exploded assembly view", () => {
  it("spreads instances away from their centroid by the factor", () => {
    // centroid x = 0.1; factor 1 → each moves by (pos − centroid)·1.
    const out = explodeInstances([inst("a", 0), inst("b", 0.2)], 1);
    expect(out[0]!.position[0]).toBeCloseTo(-0.1, 9); // 0 + (0 − 0.1)
    expect(out[1]!.position[0]).toBeCloseTo(0.3, 9); // 0.2 + (0.2 − 0.1)
  });

  it("factor 0 leaves the assembly assembled (positions unchanged)", () => {
    const out = explodeInstances([inst("a", 0), inst("b", 0.2)], 0);
    expect(out[0]!.position[0]).toBeCloseTo(0, 9);
    expect(out[1]!.position[0]).toBeCloseTo(0.2, 9);
  });

  it("a single instance cannot explode (it is the centroid)", () => {
    const out = explodeInstances([inst("solo", 0.5, 0.3, -0.2)], 2);
    expect(out[0]!.position).toEqual([0.5, 0.3, -0.2]);
  });

  it("preserves orientation and never mutates the input", () => {
    const input = [inst("a", 0), inst("b", 0.2)];
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = explodeInstances(input, 1.5);
    expect(out[0]!.orientation).toEqual([0, 0, 0, 1]);
    expect(input).toEqual(snapshot); // input untouched
  });

  it("clamps a negative factor to assembled (no implosion)", () => {
    const out = explodeInstances([inst("a", 0), inst("b", 0.2)], -3);
    expect(out[0]!.position[0]).toBeCloseTo(0, 9);
    expect(out[1]!.position[0]).toBeCloseTo(0.2, 9);
  });
});
