import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { formatMeasurement, formatMm, measurePoints } from "./measure.js";

describe("measure — point-to-point distance + readout (FR-13)", () => {
  it("computes distance and per-axis deltas in SI metres", () => {
    const m = measurePoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, 0.04, 0));
    expect(m.distance).toBeCloseTo(0.05, 9); // 3-4-5
    expect(m.delta).toEqual([0.03, 0.04, 0]);
  });

  it("deltas are absolute regardless of point order", () => {
    const a = new THREE.Vector3(0.01, 0.02, 0.03);
    const b = new THREE.Vector3(0, 0, 0);
    expect(measurePoints(a, b).delta).toEqual([0.01, 0.02, 0.03]);
  });

  it("formats metres as millimetres", () => {
    expect(formatMm(0.05)).toBe("50.00 mm");
    expect(formatMm(0.0012345)).toBe("1.23 mm");
  });

  it("the readout shows total + axis breakdown in mm", () => {
    const m = measurePoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, 0.04, 0));
    expect(formatMeasurement(m)).toBe("50.00 mm  (Δ 30.00 mm · 40.00 mm · 0.00 mm)");
  });
});
