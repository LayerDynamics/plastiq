// SPEC-6 R4.3 — fal.ai image-gen + 3D-gen providers (spec §6.5, decision 6).
//
// Concrete MeshGenProvider / ImageGenProvider implementations over fal.ai's queue API,
// using raw fetch (no SDK) so it works in the browser with a BYO key and behind the
// future proxy unchanged. Endpoints + field names verified against fal docs (2026-06):
//
//   Queue:  POST https://queue.fal.run/{model_id}          (Authorization: Key <KEY>)
//             → { request_id, status_url, response_url }
//           GET  {status_url}  → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
//           GET  {response_url} → the model's output JSON
//
//   3D:  tripo3d/tripo/v2.5/{text-to-3d,image-to-3d}  → model_mesh.url   (text + image)
//        fal-ai/meshy/v6-preview/image-to-3d          → model_glb.url    (image)
//        fal-ai/hunyuan3d/v2                          → model_mesh.url   (image)
//   Image: fal-ai/flux/{schnell,dev} + fal-ai/fast-sdxl → images[0].url  (text→image, selectable)
//
// All fal image inputs accept a base64 data URI, so a generated/attached image is sent
// inline (no fal-storage upload). Honest constraints (Risk R-1): needs network + a fal
// account (paid; gated by the create_mesh confirm), and a *direct* browser call needs
// fal CORS — the proxy seam (empty key + proxy baseURL) is the production path.
//
// NOTE: this file is exercised by createMesh.integration.test.ts (opt-in, keyed) and is
// NOT run in CI; it has not been executed against the live fal API in this environment.

import type {
  GenImage,
  ImageGenProvider,
  MeshGenJob,
  MeshGenProvider,
  MeshGenRequest,
  MeshGenStatus,
} from "./types.js";

const DEFAULT_BASE_URL = "https://queue.fal.run";

export interface FalClientConfig {
  /** fal API key (BYO). Omitted/empty when a proxy injects it server-side. */
  apiKey?: string;
  /** Override the queue base URL — also the proxy hook (decision 21). */
  baseURL?: string;
  /** Injectable fetch (tests pass a fake; defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/** A fal queue job — extends the opaque handle with the URLs poll/result need. */
interface FalJob extends MeshGenJob {
  modelId: string;
  statusUrl: string;
  responseUrl: string;
}

function authHeaders(cfg: FalClientConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h["Authorization"] = `Key ${cfg.apiKey}`;
  return h;
}

function fetchOf(cfg: FalClientConfig): typeof fetch {
  const f = cfg.fetchImpl ?? globalThis.fetch;
  if (!f) throw new Error("fal: no fetch implementation available");
  return f;
}

/** Build the data-URI form fal accepts for an inline image input. */
function dataUri(image: GenImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `fal HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`;
}

/** POST a job to the fal queue and return its handle URLs. */
async function falSubmit(
  cfg: FalClientConfig,
  modelId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ requestId: string; statusUrl: string; responseUrl: string }> {
  const base = cfg.baseURL ?? DEFAULT_BASE_URL;
  const res = await fetchOf(cfg)(`${base}/${modelId}`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(await readError(res));
  const json = (await res.json()) as { request_id?: string; status_url?: string; response_url?: string };
  if (!json.request_id || !json.status_url || !json.response_url) {
    throw new Error("fal submit: response missing request_id/status_url/response_url");
  }
  return { requestId: json.request_id, statusUrl: json.status_url, responseUrl: json.response_url };
}

/** Read a nested string at `path` (e.g. ["model_mesh","url"]) from an output JSON. */
function readStringPath(output: unknown, path: readonly string[]): string | undefined {
  let cur: unknown = output;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

/** Per-model wiring: which fal endpoint serves each mode, the image field name, and
 * where the GLB URL lives in the output. */
interface FalMeshModelSpec {
  id: string;
  label: string;
  /** fal endpoint for text→3d (absent ⇒ no text3d support). */
  textModelId?: string;
  /** fal endpoint for image→3d (absent ⇒ no img3d support). */
  imageModelId?: string;
  /** Input field for the inline image on the image endpoint. */
  imageField: string;
  /** Optional model field a `quality` hint maps to (only set when verified). */
  qualityField?: string;
  /** Path to the GLB URL in the output JSON. */
  glbPath: readonly string[];
}

class FalMeshGenProvider implements MeshGenProvider {
  readonly id: string;
  readonly label: string;
  readonly supports: { text3d: boolean; img3d: boolean };

  constructor(
    private readonly cfg: FalClientConfig,
    private readonly spec: FalMeshModelSpec,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.supports = { text3d: spec.textModelId != null, img3d: spec.imageModelId != null };
  }

  async submit(req: MeshGenRequest, signal?: AbortSignal): Promise<MeshGenJob> {
    const input: Record<string, unknown> = {};
    let modelId: string;
    if (req.image) {
      if (!this.spec.imageModelId) throw new Error(`${this.id} does not support image→3d`);
      modelId = this.spec.imageModelId;
      input[this.spec.imageField] = dataUri(req.image);
    } else if (req.prompt) {
      if (!this.spec.textModelId) throw new Error(`${this.id} does not support text→3d`);
      modelId = this.spec.textModelId;
      input["prompt"] = req.prompt;
    } else {
      throw new Error(`${this.id}: a request needs a prompt or an image`);
    }
    if (req.quality && this.spec.qualityField) input[this.spec.qualityField] = req.quality;

    const { requestId, statusUrl, responseUrl } = await falSubmit(this.cfg, modelId, input, signal);
    const job: FalJob = { id: requestId, modelId, statusUrl, responseUrl };
    return job;
  }

  async poll(job: MeshGenJob, signal?: AbortSignal): Promise<MeshGenStatus> {
    const fal = job as FalJob;
    const f = fetchOf(this.cfg);
    const statusRes = await f(fal.statusUrl, { headers: authHeaders(this.cfg), ...(signal ? { signal } : {}) });
    if (!statusRes.ok) return { state: "failed", error: await readError(statusRes) };
    const status = (await statusRes.json()) as { status?: string };
    if (status.status === "IN_QUEUE") return { state: "pending" };
    if (status.status === "IN_PROGRESS") return { state: "running" };
    if (status.status !== "COMPLETED") return { state: "failed", error: `unexpected status '${status.status ?? "?"}'` };

    const resultRes = await f(fal.responseUrl, { headers: authHeaders(this.cfg), ...(signal ? { signal } : {}) });
    if (!resultRes.ok) return { state: "failed", error: await readError(resultRes) };
    const output = await resultRes.json();
    const glbUrl = readStringPath(output, this.spec.glbPath);
    if (!glbUrl) return { state: "failed", error: `fal result had no GLB url at ${this.spec.glbPath.join(".")}` };
    return { state: "succeeded", glbUrl };
  }
}

/** Per-model wiring for a fal text→image endpoint (mirrors FalMeshModelSpec). All the
 * shipped models return images[0].url, so the endpoint id is the only thing that varies. */
interface FalImageModelSpec {
  /** Stable provider id for selection/persistence, e.g. "fal:flux-schnell". */
  id: string;
  /** Human-facing label for the picker. */
  label: string;
  /** fal text→image endpoint (doc-verified against fal's model registry). */
  modelId: string;
}

class FalImageGenProvider implements ImageGenProvider {
  readonly id: string;
  readonly label: string;
  private readonly modelId: string;

  constructor(
    private readonly cfg: FalClientConfig,
    spec: FalImageModelSpec,
  ) {
    this.id = spec.id;
    this.label = spec.label;
    this.modelId = spec.modelId;
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<GenImage> {
    const { statusUrl, responseUrl } = await falSubmit(this.cfg, this.modelId, { prompt }, signal);
    const f = fetchOf(this.cfg);
    // Bounded poll (image-gen is fast — a few seconds).
    for (let i = 0; i < 60; i++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const sRes = await f(statusUrl, { headers: authHeaders(this.cfg), ...(signal ? { signal } : {}) });
      if (!sRes.ok) throw new Error(await readError(sRes));
      const s = (await sRes.json()) as { status?: string };
      if (s.status === "COMPLETED") break;
      if (s.status !== "IN_QUEUE" && s.status !== "IN_PROGRESS") {
        throw new Error(`fal image-gen unexpected status '${s.status ?? "?"}'`);
      }
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    const rRes = await f(responseUrl, { headers: authHeaders(this.cfg), ...(signal ? { signal } : {}) });
    if (!rRes.ok) throw new Error(await readError(rRes));
    const output = (await rRes.json()) as { images?: { url?: string; content_type?: string }[] };
    const img = output.images?.[0];
    if (!img?.url) throw new Error("fal image-gen result had no images[0].url");

    // fal returns an image URL; fetch it and inline as base64 for the GenImage contract.
    const imgRes = await f(img.url, signal ? { signal } : {});
    if (!imgRes.ok) throw new Error(await readError(imgRes));
    const buf = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return { mediaType: img.content_type ?? "image/jpeg", data: btoa(binary) };
  }
}

/** The shipped fal 3D-gen providers (decision 6: selectable, no default). */
export function falMeshProviders(cfg: FalClientConfig): MeshGenProvider[] {
  return [
    new FalMeshGenProvider(cfg, {
      id: "fal:tripo",
      label: "Tripo v2.5 (fast, text + image)",
      textModelId: "tripo3d/tripo/v2.5/text-to-3d",
      imageModelId: "tripo3d/tripo/v2.5/image-to-3d",
      imageField: "image_url",
      qualityField: "texture", // verified enum: no | standard | HD
      glbPath: ["model_mesh", "url"],
    }),
    new FalMeshGenProvider(cfg, {
      id: "fal:meshy",
      label: "Meshy v6 (quality / PBR, image)",
      imageModelId: "fal-ai/meshy/v6-preview/image-to-3d",
      imageField: "image_url",
      glbPath: ["model_glb", "url"],
    }),
    new FalMeshGenProvider(cfg, {
      id: "fal:hunyuan3d",
      label: "Hunyuan3D v2 (open, image)",
      imageModelId: "fal-ai/hunyuan3d/v2",
      imageField: "input_image_url",
      glbPath: ["model_mesh", "url"],
    }),
  ];
}

/** The shipped fal image-gen providers (the text→image stage of text2img3d), selectable
 * by id (decision 6). Endpoint ids are doc-verified against fal's text-to-image model
 * registry (2026-07); like the rest of this file they have NOT been run against the live
 * API here. All three return images[0].url, so they share FalImageGenProvider unchanged.
 * Order matters: index 0 (FLUX schnell, the cheapest) is the default when unset. */
export function falImageProviders(cfg: FalClientConfig): ImageGenProvider[] {
  return [
    new FalImageGenProvider(cfg, {
      id: "fal:flux-schnell",
      label: "FLUX schnell (fast, cheapest)",
      modelId: "fal-ai/flux/schnell",
    }),
    new FalImageGenProvider(cfg, {
      id: "fal:flux-dev",
      label: "FLUX dev (higher quality)",
      modelId: "fal-ai/flux/dev",
    }),
    new FalImageGenProvider(cfg, {
      id: "fal:fast-sdxl",
      label: "Fast SDXL (SDXL, low cost)",
      modelId: "fal-ai/fast-sdxl",
    }),
  ];
}

/** id → provider lookup over a provider list (satisfies createMesh's resolver dep). */
export function meshProviderRegistry(providers: MeshGenProvider[]): (id: string) => MeshGenProvider | undefined {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return (id) => byId.get(id);
}
