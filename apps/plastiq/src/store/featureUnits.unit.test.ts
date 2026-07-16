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
    // C8: variable fillet / two-distance chamfer are LENGTHS (mm ↔ m).
    expect(classifyParam("fillet", "radius2")).toBe("length");
    expect(classifyParam("chamfer", "distance2")).toBe("length");
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

  it("converts radius2 and distance2 as lengths (C8 — not unitless scalars)", () => {
    // SI 0.002 m → display 2 mm (if omitted from LENGTH_PARAMS this would show 0.002).
    expect(toDisplayValue("fillet", "radius2", 0.002)).toBeCloseTo(2, 9);
    expect(toDisplayValue("chamfer", "distance2", 0.002)).toBeCloseTo(2, 9);
    // User types 3 mm → stores 0.003 m (if unitless, would store 3 m).
    expect(fromDisplayValue("fillet", "radius2", 3)).toBeCloseTo(mm(3), 12);
    expect(fromDisplayValue("chamfer", "distance2", 3)).toBeCloseTo(mm(3), 12);
    expect(unitSuffix("fillet", "radius2")).toBe("mm");
    expect(unitSuffix("chamfer", "distance2")).toBe("mm");
  });

  it("reports the right unit suffix", () => {
    expect(unitSuffix("box", "dx")).toBe("mm");
    expect(unitSuffix("revolve", "angle")).toBe("°");
    expect(unitSuffix("linearPattern", "count")).toBe("");
  });
});
