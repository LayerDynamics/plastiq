import { describe, expect, it } from "vitest";
import { featureDragValue } from "./featureGizmo.js";

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
