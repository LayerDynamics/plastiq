// SPEC-6 R4.3 — buildMeshGenDeps wires the create_mesh provider deps from settings.
// Pure (no network): asserts the fal 3D-gen providers resolve by id, the image provider
// is present, and meshGenConfigured reflects whether the creative path can authenticate.

import { describe, expect, it } from "vitest";
import { buildMeshGenDeps, meshGenConfigured } from "./meshGenDeps.js";
import type { AiSettings } from "./settings.js";

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    providerKey: "ollama",
    providerId: "openai-compatible",
    model: "qwen2.5",
    apiKeys: {},
    ...overrides,
  };
}

describe("buildMeshGenDeps", () => {
  it("resolves the shipped fal 3D-gen providers by id", () => {
    const deps = buildMeshGenDeps(settings({ apiKeys: { fal: "k" } }));
    expect(deps.resolveMeshProvider("fal:tripo")?.id).toBe("fal:tripo");
    expect(deps.resolveMeshProvider("fal:meshy")?.id).toBe("fal:meshy");
    expect(deps.resolveMeshProvider("fal:hunyuan3d")?.id).toBe("fal:hunyuan3d");
    expect(deps.resolveMeshProvider("fal:does-not-exist")).toBeUndefined();
  });

  it("exposes an image-gen provider (the text→image stage of text2img3d)", () => {
    const deps = buildMeshGenDeps(settings());
    expect(deps.imageProvider).toBeDefined();
    expect(deps.providers.length).toBeGreaterThan(0);
  });

  it("tripo advertises both text→3D and image→3D; meshy is image-only", () => {
    const deps = buildMeshGenDeps(settings());
    expect(deps.resolveMeshProvider("fal:tripo")?.supports).toEqual({ text3d: true, img3d: true });
    expect(deps.resolveMeshProvider("fal:meshy")?.supports).toEqual({ text3d: false, img3d: true });
  });
});

describe("meshGenConfigured", () => {
  it("is false with no fal key and no proxy (honest: the path can't authenticate)", () => {
    expect(meshGenConfigured(settings())).toBe(false);
  });
  it("is true with a BYO fal key", () => {
    expect(meshGenConfigured(settings({ apiKeys: { fal: "k" } }))).toBe(true);
  });
  it("is true with a proxy base URL (key injected server-side)", () => {
    expect(meshGenConfigured(settings({ meshGenBaseURL: "https://proxy.example/fal" }))).toBe(true);
  });
});
