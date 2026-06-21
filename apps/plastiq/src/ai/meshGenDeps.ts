// SPEC-6 R4.3 — wire the create_mesh tool's provider-side dependencies from settings.
//
// createMesh (tools/createMesh.ts) takes every external dependency injected so it stays
// testable. This module builds the *provider-side* deps (3D-gen + image-gen resolution,
// GLB download, GLB validation) from the persisted AiSettings; the GenerationPanel
// supplies the UI-side deps (the paid-job confirm dialog, persist, recordPaidJob, signal).
//
// HONEST CAVEAT (Risk R-1, decision 21): the fal key lives in settings.apiKeys["fal"];
// a *direct* browser→fal call needs fal CORS, so in practice this works through the proxy
// seam (settings.meshGenBaseURL → a proxy that injects the key server-side) or a CORS-
// enabled key. With no key and no proxy, submit() fails cleanly (create_mesh returns a
// structured error) — it never silently no-ops.

import { falImageProviders, falMeshProviders, meshProviderRegistry, type FalClientConfig } from "./meshgen/fal.js";
import { importGltf } from "../mesh/importGltf.js";
import type { AiSettings } from "./settings.js";
import type { ImageGenProvider, MeshGenProvider } from "./meshgen/types.js";

/** The provider-side slice of CreateMeshDeps, derived from settings. */
export interface MeshGenProviderDeps {
  resolveMeshProvider: (id: string) => MeshGenProvider | undefined;
  imageProvider: ImageGenProvider;
  fetchGlb: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  validateGlb: (glb: ArrayBuffer) => Promise<void>;
  /** The fal 3D-gen providers offered (for surfacing the selectable list in the UI). */
  providers: MeshGenProvider[];
}

/** Build the create_mesh provider deps from the active AI settings (fal key + proxy URL). */
export function buildMeshGenDeps(settings: AiSettings): MeshGenProviderDeps {
  const cfg: FalClientConfig = {
    ...(settings.apiKeys["fal"] ? { apiKey: settings.apiKeys["fal"] } : {}),
    ...(settings.meshGenBaseURL ? { baseURL: settings.meshGenBaseURL } : {}),
  };
  const providers = falMeshProviders(cfg);
  return {
    resolveMeshProvider: meshProviderRegistry(providers),
    imageProvider: falImageProviders(cfg)[0]!,
    fetchGlb: async (url, signal) => (await fetch(url, signal ? { signal } : {})).arrayBuffer(),
    validateGlb: async (glb) => {
      await importGltf(glb); // throws on no geometry — gate before persisting
    },
    providers,
  };
}

/** True when the creative mesh-gen path can actually authenticate — a fal key or a
 * configured proxy base URL is present. The panel uses this to show an honest hint
 * (offer the tool regardless, but tell the user it needs a key/proxy to run). */
export function meshGenConfigured(settings: AiSettings): boolean {
  return Boolean(settings.apiKeys["fal"] || settings.meshGenBaseURL);
}
