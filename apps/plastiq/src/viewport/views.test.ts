import { describe, expect, it } from "vitest";
import { standardViewDirection, type StandardView } from "./views.js";

describe("standardViewDirection — Z-up camera directions (FR-12)", () => {
  it("axis views point along the expected world axis", () => {
    expect(standardViewDirection("top").toArray()).toEqual([0, 0, 1]);
    expect(standardViewDirection("front").toArray()).toEqual([0, -1, 0]);
    expect(standardViewDirection("right").toArray()).toEqual([1, 0, 0]);
    expect(standardViewDirection("left").toArray()).toEqual([-1, 0, 0]);
  });

  it("every standard direction is a unit vector", () => {
    const views: StandardView[] = ["top", "bottom", "front", "back", "right", "left", "iso"];
    for (const v of views) expect(standardViewDirection(v).length()).toBeCloseTo(1, 9);
  });

  it("iso looks down from the +X/−Y/+Z octant", () => {
    const d = standardViewDirection("iso");
    expect(d.x).toBeGreaterThan(0);
    expect(d.y).toBeLessThan(0);
    expect(d.z).toBeGreaterThan(0);
  });
});
