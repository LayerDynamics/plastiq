// SPEC-6 R4.3 — fal provider registry shape (pure; no network). Asserts the shipped
// selectable providers (decision 6). Endpoint ids are doc-verified against fal's model
// registry, NOT run against the live API here (see the fal.ts header + the opt-in, keyed
// createMesh.integration.test.ts for the live run).

import { describe, expect, it } from "vitest";
import { falImageProviders, falMeshProviders } from "./fal.js";

const cfg = { apiKey: "test-key" };

describe("falImageProviders (selectable image-gen models — decision 6)", () => {
  it("ships more than one image model with stable, fal-verified ids", () => {
    const ids = falImageProviders(cfg).map((p) => p.id);
    expect(ids).toEqual(["fal:flux-schnell", "fal:flux-dev", "fal:fast-sdxl"]);
  });

  it("puts FLUX schnell first (the cheapest — the default when unset)", () => {
    expect(falImageProviders(cfg)[0]?.id).toBe("fal:flux-schnell");
  });

  it("gives every image provider a human label and a generate() for the picker", () => {
    for (const p of falImageProviders(cfg)) {
      expect(p.id).toMatch(/^fal:/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.generate).toBe("function");
    }
  });
});

describe("falMeshProviders (selectable 3D-gen models)", () => {
  it("ships tripo/meshy/hunyuan3d by id (the image provider list parallels this)", () => {
    const ids = falMeshProviders(cfg).map((p) => p.id);
    expect(ids).toEqual(["fal:tripo", "fal:meshy", "fal:hunyuan3d"]);
  });
});
