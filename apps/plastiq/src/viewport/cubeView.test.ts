import { describe, expect, it } from "vitest";
import { CUBE_REGIONS, cubeDirection, cubeRegion } from "./cubeView.js";
import { standardViewDirection } from "./views.js";

describe("view cube — regions + directions (FR-12)", () => {
  it("enumerates 6 faces + 12 edges + 8 corners = 26 regions", () => {
    expect(CUBE_REGIONS).toHaveLength(26);
    const byKind = (k: string): number => CUBE_REGIONS.filter((r) => r.kind === k).length;
    expect(byKind("face")).toBe(6);
    expect(byKind("edge")).toBe(12);
    expect(byKind("corner")).toBe(8);
  });

  it("ids classify a face, an edge and a corner", () => {
    expect(cubeRegion("T")?.kind).toBe("face");
    expect(cubeRegion("TR")?.kind).toBe("edge");
    expect(cubeRegion("TFR")?.kind).toBe("corner");
  });

  it("face direction is the axis normal", () => {
    const d = cubeDirection([0, 0, 1]);
    expect([d.x, d.y, d.z]).toEqual([0, 0, 1]);
  });

  it("edge direction bisects two faces (unit length)", () => {
    const d = cubeDirection([1, 0, 1]);
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(d.z).toBeCloseTo(Math.SQRT1_2, 9);
    expect(d.length()).toBeCloseTo(1, 9);
  });

  it("the near corner matches the iso standard view", () => {
    const corner = cubeDirection([1, -1, 1]);
    const iso = standardViewDirection("iso");
    expect(corner.x).toBeCloseTo(iso.x, 9);
    expect(corner.y).toBeCloseTo(iso.y, 9);
    expect(corner.z).toBeCloseTo(iso.z, 9);
  });

  it("every region direction is a unit vector", () => {
    for (const r of CUBE_REGIONS) {
      expect(cubeDirection(r.axes).length()).toBeCloseTo(1, 9);
    }
  });
});
