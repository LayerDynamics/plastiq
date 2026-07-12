// Shared feature unit semantics (used by the AI converter + the properties panel).

import { describe, it, expect } from "vitest";
import {
  FEATURE_TYPES,
  classifyParam,
  toDisplayValue,
  fromDisplayValue,
  unitSuffix,
} from "./featureUnits.js";
import { mm, deg } from "@plastiq/cad";

describe("featureUnits classification", () => {
  it("classifies lengths, angles, and scalars per feature type", () => {
    expect(classifyParam("box", "dx")).toBe("length");
    expect(classifyParam("revolve", "angle")).toBe("angle");
    expect(classifyParam("revolve", "ax")).toBe("scalar"); // axis component
    expect(classifyParam("revolve", "ox")).toBe("length"); // axis origin
    expect(classifyParam("linearPattern", "count")).toBe("scalar");
    expect(classifyParam("linearPattern", "spacing")).toBe("length");
    expect(classifyParam("placement", "rz")).toBe("angle");
  });

  it("covers the full rebuild feature set", () => {
    expect(FEATURE_TYPES).toContain("box");
    expect(FEATURE_TYPES).toContain("circularPattern");
    expect(FEATURE_TYPES).toContain("importStep");
  });
});

describe("featureUnits display conversion", () => {
  it("SI → display (mm/deg)", () => {
    expect(toDisplayValue("box", "dx", 0.04)).toBeCloseTo(40, 9);
    expect(toDisplayValue("revolve", "angle", deg(90))).toBeCloseTo(90, 9);
    expect(toDisplayValue("linearPattern", "count", 3)).toBe(3); // scalar untouched
  });

  it("display (mm/deg) → SI, round-trips", () => {
    expect(fromDisplayValue("box", "dx", 40)).toBeCloseTo(mm(40), 12);
    expect(fromDisplayValue("revolve", "angle", 90)).toBeCloseTo(deg(90), 12);
    expect(toDisplayValue("box", "dx", fromDisplayValue("box", "dx", 25))).toBeCloseTo(25, 9);
  });

  it("reports the right unit suffix", () => {
    expect(unitSuffix("box", "dx")).toBe("mm");
    expect(unitSuffix("revolve", "angle")).toBe("°");
    expect(unitSuffix("linearPattern", "count")).toBe("");
  });
});
