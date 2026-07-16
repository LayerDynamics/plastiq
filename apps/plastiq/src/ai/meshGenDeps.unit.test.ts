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

describe("buildMeshGenDeps — selectable image-gen provider (decision 6)", () => {
  it("defaults to FLUX schnell (the cheapest) when imageProviderId is unset", () => {
    expect(buildMeshGenDeps(settings()).imageProvider?.id).toBe("fal:flux-schnell");
  });

  it("resolves every shipped image model by id (via resolveImageProvider and the selection)", () => {
    const deps = buildMeshGenDeps(settings());
    for (const id of ["fal:flux-schnell", "fal:flux-dev", "fal:fast-sdxl"]) {
      expect(deps.resolveImageProvider(id)?.id).toBe(id);
      expect(buildMeshGenDeps(settings({ imageProviderId: id })).imageProvider?.id).toBe(id);
    }
  });

  it("selects the persisted image model, not the hardwired default", () => {
    const deps = buildMeshGenDeps(settings({ imageProviderId: "fal:flux-dev" }));
    expect(deps.imageProvider?.id).toBe("fal:flux-dev");
  });

  it("an unknown persisted id resolves to no provider (createMesh then errors — the 3D path)", () => {
    const deps = buildMeshGenDeps(settings({ imageProviderId: "fal:does-not-exist" }));
    expect(deps.imageProvider).toBeUndefined();
    expect(deps.resolveImageProvider("fal:does-not-exist")).toBeUndefined();
  });

  it("exposes the selectable image-provider list for the UI (task #45 seam)", () => {
    const ids = buildMeshGenDeps(settings()).imageProviders.map((p) => p.id);
    expect(ids).toContain("fal:flux-dev");
    expect(ids.length).toBeGreaterThan(1);
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
