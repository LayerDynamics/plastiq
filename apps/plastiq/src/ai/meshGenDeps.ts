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

/** Default fal image-gen model for the text→image stage of text2img3d when
 * settings.imageProviderId is unset — FLUX schnell, the cheapest (matches the prior
 * hardwired behaviour). The UI (task #45) offers this as the default selection. Must be
 * an id from falImageProviders. */
export const DEFAULT_IMAGE_PROVIDER_ID = "fal:flux-schnell";

/** The provider-side slice of CreateMeshDeps, derived from settings. */
export interface MeshGenProviderDeps {
  resolveMeshProvider: (id: string) => MeshGenProvider | undefined;
  /** Selected image-gen provider for the text→image stage of text2img3d — resolved from
   * settings.imageProviderId (the default when unset). Undefined when a persisted id no
   * longer resolves; createMesh then returns a structured error on the text2img3d branch,
   * the same lazy behaviour as an unknown 3D-provider id. */
  imageProvider?: ImageGenProvider;
  fetchGlb: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  validateGlb: (glb: ArrayBuffer) => Promise<void>;
  /** The fal 3D-gen providers offered (for surfacing the selectable list in the UI). */
  providers: MeshGenProvider[];
  /** The fal image-gen providers offered (for the selectable image-model list in the UI). */
  imageProviders: ImageGenProvider[];
  /** id → image provider lookup (mirrors resolveMeshProvider; the UI validates a pick). */
  resolveImageProvider: (id: string) => ImageGenProvider | undefined;
}

/** Build the create_mesh provider deps from the active AI settings (fal key + proxy URL). */
export function buildMeshGenDeps(settings: AiSettings): MeshGenProviderDeps {
  const cfg: FalClientConfig = {
    ...(settings.apiKeys["fal"] ? { apiKey: settings.apiKeys["fal"] } : {}),
    ...(settings.meshGenBaseURL ? { baseURL: settings.meshGenBaseURL } : {}),
  };
  const providers = falMeshProviders(cfg);
  const imageProviders = falImageProviders(cfg);
  // id → image provider lookup, built inline (parallels meshProviderRegistry) so this
  // module's fal.js import surface stays stable for the shared CommandPalette test mock.
  const imageById = new Map(imageProviders.map((p) => [p.id, p] as const));
  const resolveImageProvider = (id: string): ImageGenProvider | undefined => imageById.get(id);
  // Selected image provider: the persisted id when set (unknown ⇒ undefined ⇒ a structured
  // error on the text2img3d branch of createMesh, same as an unknown 3D-provider id); else
  // the default (FLUX schnell — [0] is a safety net should the default id ever move).
  const imageProvider = settings.imageProviderId
    ? resolveImageProvider(settings.imageProviderId)
    : (resolveImageProvider(DEFAULT_IMAGE_PROVIDER_ID) ?? imageProviders[0]!);
  return {
    resolveMeshProvider: meshProviderRegistry(providers),
    imageProvider,
    fetchGlb: async (url, signal) => (await fetch(url, signal ? { signal } : {})).arrayBuffer(),
    validateGlb: async (glb) => {
      await importGltf(glb); // throws on no geometry — gate before persisting
    },
    providers,
    imageProviders,
    resolveImageProvider,
  };
}

/** True when the creative mesh-gen path can actually authenticate — a fal key or a
 * configured proxy base URL is present. The panel uses this to show an honest hint
 * (offer the tool regardless, but tell the user it needs a key/proxy to run). */
export function meshGenConfigured(settings: AiSettings): boolean {
  return Boolean(settings.apiKeys["fal"] || settings.meshGenBaseURL);
}
