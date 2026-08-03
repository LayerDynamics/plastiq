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
    expect(FEATURE_TYPES).toContain("pathPattern");
    expect(FEATURE_TYPES).toContain("split");
    expect(FEATURE_TYPES).toContain("section");
    expect(FEATURE_TYPES).toContain("importStep");
    expect(FEATURE_TYPES).toContain("freeform");
    expect(FEATURE_TYPES).toContain("thicken");
    expect(FEATURE_TYPES).toContain("hole");
    expect(FEATURE_TYPES).toContain("scale");
    expect(FEATURE_TYPES).toContain("sweep");
    // §14 surface pillar
    expect(FEATURE_TYPES).toContain("surfaceLoft");
    expect(FEATURE_TYPES).toContain("surfaceSweep");
    expect(FEATURE_TYPES).toContain("surfaceRevolve");
    expect(FEATURE_TYPES).toContain("offsetSurface");
    expect(FEATURE_TYPES).toContain("sew");
    expect(FEATURE_TYPES).toContain("solidify");
    expect(FEATURE_TYPES).toContain("surfaceFromPoints");
    // Helix is not a FEATURE_TYPES entry — it is data.helix on type "sweep".
    expect(FEATURE_TYPES).not.toContain("helix");
  });

  it("pathPattern count is a unitless scalar (spine lives in data)", () => {
    expect(classifyParam("pathPattern", "count")).toBe("scalar");
  });

  it("classifies freeform size params as lengths (§15)", () => {
    expect(classifyParam("freeform", "uSize")).toBe("length");
    expect(classifyParam("freeform", "vSize")).toBe("length");
    expect(classifyParam("freeform", "radius")).toBe("length");
    expect(classifyParam("freeform", "height")).toBe("length");
    expect(classifyParam("freeform", "ox")).toBe("length");
    expect(classifyParam("freeform", "resU")).toBe("scalar");
    expect(classifyParam("freeform", "ax")).toBe("scalar");
  });

  it("classifies §14 surface length/angle params", () => {
    expect(classifyParam("offsetSurface", "distance")).toBe("length");
    expect(classifyParam("sew", "tolerance")).toBe("length");
    expect(classifyParam("surfaceRevolve", "angle")).toBe("angle");
    expect(classifyParam("surfaceRevolve", "ox")).toBe("length");
    expect(classifyParam("surfaceRevolve", "ay")).toBe("scalar");
    expect(unitSuffix("offsetSurface", "distance")).toBe("mm");
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

  it("classifies native extrude draftAngle as an angle", () => {
    expect(classifyParam("extrude", "draftAngle")).toBe("angle");
    expect(unitSuffix("extrude", "draftAngle")).toBe("°");
    expect(fromDisplayValue("extrude", "draftAngle", 5)).toBeCloseTo((5 * Math.PI) / 180, 12);
  });

  it("reports the right unit suffix", () => {
    expect(unitSuffix("box", "dx")).toBe("mm");
    expect(unitSuffix("revolve", "angle")).toBe("°");
    expect(unitSuffix("linearPattern", "count")).toBe("");
  });
});
