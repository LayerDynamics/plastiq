import { describe, expect, it } from "vitest";
import { emptySketch } from "./model.js";
import { effectivePlaneFrame, syncPlaneFrame } from "./planeFrame.js";

describe("planeFrame", () => {
  it("syncPlaneFrame resolves a datum sketch", () => {
    const m = emptySketch("XZ", 0.01);
    const f = syncPlaneFrame(m);
    expect(f).not.toBeNull();
    expect(f!.normal[1]).toBeCloseTo(1, 9);
    expect(f!.origin[1]).toBeCloseTo(0.01, 9); // offset along +Y for XZ
  });

  it("syncPlaneFrame returns null for face sketches (async frame required)", () => {
    const m = {
      ...emptySketch("XY"),
      face: { normal: [0, 0, 1] as [number, number, number] },
    };
    expect(syncPlaneFrame(m)).toBeNull();
  });

  it("effectivePlaneFrame prefers the live face frame", () => {
    const m = {
      ...emptySketch("XY"),
      face: { normal: [0, 0, 1] as [number, number, number] },
    };
    const live = {
      origin: [0, 0, 0.03] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
      xAxis: [1, 0, 0] as [number, number, number],
    };
    expect(effectivePlaneFrame(m, live)).toEqual(live);
    expect(effectivePlaneFrame(m, null)).toBeNull();
  });
});
