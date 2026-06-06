import { describe, expect, it } from "vitest";
import { resolveDatumPlane, resolveSketchPlane } from "./sketchPlane.js";

describe("resolveDatumPlane — sketch plane spec → kernel DatumPlane", () => {
  it("maps each base datum to the right normal", () => {
    expect(resolveDatumPlane("XY").normal).toEqual([0, 0, 1]);
    expect(resolveDatumPlane("XZ").normal).toEqual([0, 1, 0]);
    expect(resolveDatumPlane("YZ").normal).toEqual([1, 0, 0]);
  });

  it("shifts the origin along the base normal by the offset (SI metres)", () => {
    expect(resolveDatumPlane("XY", 0.05).origin).toEqual([0, 0, 0.05]);
    expect(resolveDatumPlane("XZ", 0.05).origin).toEqual([0, 0.05, 0]);
    expect(resolveDatumPlane("YZ", -0.02).origin).toEqual([-0.02, 0, 0]);
    // The frame (normal + xAxis) is unchanged by the offset.
    expect(resolveDatumPlane("XZ", 0.05).xAxis).toEqual([1, 0, 0]);
  });

  it("defaults to XY at offset 0 — back-compat for docs with no stored plane", () => {
    const xy = resolveDatumPlane();
    expect(xy.normal).toEqual([0, 0, 1]);
    expect(xy.origin).toEqual([0, 0, 0]);
    expect(resolveSketchPlane(undefined)).toEqual(xy);
  });

  it("resolveSketchPlane reads a compiled spec", () => {
    expect(resolveSketchPlane({ base: "YZ", offset: 0.1 }).origin).toEqual([0.1, 0, 0]);
  });
});
