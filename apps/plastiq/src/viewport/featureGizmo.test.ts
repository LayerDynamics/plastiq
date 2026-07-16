import { describe, expect, it } from "vitest";
import {
  FEATURE_SECONDARY_PARAMS,
  featureDragValue,
  fromDisplayUnit,
  MIN_SI,
  scrubToSI,
  toDisplayUnit,
} from "./featureGizmo.js";

describe("featureDragValue — interactive feature-edit drag write-back", () => {
  const MIN = 5e-4; // 0.5 mm floor (the gizmo's MIN_VALUE)

  it("returns the handle's signed distance from the anchor along the axis", () => {
    expect(featureDragValue(0, 0.02, MIN)).toBeCloseTo(0.02, 9); // dragged 20mm out
    expect(featureDragValue(0.1, 0.13, MIN)).toBeCloseTo(0.03, 9); // anchor offset on the axis
  });

  it("floors at min so the feature never collapses past zero thickness", () => {
    expect(featureDragValue(0, 0, MIN)).toBe(MIN); // handle exactly on the anchor
    expect(featureDragValue(0, -0.5, MIN)).toBe(MIN); // dragged behind the anchor
    expect(featureDragValue(0.2, 0.2, MIN)).toBe(MIN); // same, with an offset anchor
  });

  it("is monotonic in the handle position above the floor", () => {
    expect(featureDragValue(0, 0.01, MIN)).toBeLessThan(featureDragValue(0, 0.02, MIN));
    expect(featureDragValue(0, 0.02, MIN)).toBeLessThan(featureDragValue(0, 0.05, MIN));
  });
});

describe("unit conversion — mm for lengths, degrees for angles", () => {
  it("converts SI ↔ display for mm (×1000) and round-trips", () => {
    expect(toDisplayUnit(0.02, "mm")).toBeCloseTo(20, 9); // 20mm
    expect(fromDisplayUnit(50, "mm")).toBeCloseTo(0.05, 9); // 50mm → 0.05m
    expect(fromDisplayUnit(toDisplayUnit(0.0123, "mm"), "mm")).toBeCloseTo(0.0123, 9);
  });

  it("converts SI ↔ display for degrees (radians ↔ deg) and round-trips", () => {
    expect(toDisplayUnit(Math.PI, "deg")).toBeCloseTo(180, 9); // π rad = 180°
    expect(toDisplayUnit(Math.PI * 2, "deg")).toBeCloseTo(360, 9); // a full revolve
    expect(fromDisplayUnit(90, "deg")).toBeCloseTo(Math.PI / 2, 9);
    expect(fromDisplayUnit(toDisplayUnit(0.7, "deg"), "deg")).toBeCloseTo(0.7, 9);
  });
});

describe("FEATURE_SECONDARY_PARAMS (T16)", () => {
  it("lists back for extrude/cut and spacing/count for linear pattern", () => {
    expect(FEATURE_SECONDARY_PARAMS.extrude).toContain("back");
    expect(FEATURE_SECONDARY_PARAMS.cut).toContain("back");
    expect(FEATURE_SECONDARY_PARAMS.linearPattern).toEqual(
      expect.arrayContaining(["spacing", "count"]),
    );
  });
});

describe("scrubToSI — value-box drag-scrub write-back", () => {
  it("drag right increases, drag left decreases, in display units", () => {
    const base = scrubToSI(20, 0, "mm"); // no drag → ~20mm
    expect(base).toBeCloseTo(0.02, 6);
    expect(scrubToSI(20, 40, "mm")).toBeGreaterThan(base); // +40px → larger
    expect(scrubToSI(20, -10, "mm")).toBeLessThan(base); // dragged left → smaller
  });

  it("scrubs an angle in degrees and returns radians", () => {
    // 90px right at 3px/deg = +30° from a 180° start → 210° = 7π/6 rad.
    expect(scrubToSI(180, 90, "deg")).toBeCloseTo((210 * Math.PI) / 180, 6);
  });

  it("floors at MIN_SI so a big left drag never goes to zero/negative", () => {
    expect(scrubToSI(5, -10_000, "mm")).toBe(MIN_SI);
    expect(scrubToSI(10, -10_000, "deg")).toBe(MIN_SI);
  });
});
