import { beforeAll, describe, expect, it } from "vitest";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { exportIges, importIges } from "./iges.js";
import { exportStep, importStep } from "./step.js";

const INIT_TIMEOUT_MS = 120_000;

describe("STEP interchange (FR-33)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("round-trips a solid through STEP preserving topology + volume", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40)); // 2.4e-5 m³
    try {
      const text = exportStep(oc, box);
      expect(text.startsWith("ISO-10303-21")).toBe(true);
      const reloaded = importStep(oc, text);
      try {
        expect(reloaded.isValid()).toBe(true);
        expect(reloaded.countFaces()).toBe(6);
        const v0 = massProperties(oc, box, 1).volume;
        const v1 = massProperties(oc, reloaded, 1).volume;
        expect(Math.abs(v1 - v0) / v0).toBeLessThan(1e-6);
      } finally {
        reloaded.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("rejects malformed STEP with a typed error (NFR-3)", () => {
    expect(() => importStep(oc, "this is not a STEP file")).toThrow(/STEP import/);
  });
});

describe("IGES interchange (FR-33)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("round-trips a solid's boundary through IGES (faces preserved)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const text = exportIges(oc, box);
      expect(text.length).toBeGreaterThan(0);
      const reloaded = importIges(oc, text);
      try {
        // IGES is surface-based: the box comes back as its 6 boundary faces.
        expect(reloaded.countFaces()).toBeGreaterThanOrEqual(6);
      } finally {
        reloaded.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("rejects malformed IGES with a typed error (NFR-3)", () => {
    expect(() => importIges(oc, "not an iges file")).toThrow(/IGES import/);
  });
});
