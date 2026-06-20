// SPEC-6 R4.3 — the `create_mesh` tool handler (FR-15, FR-17, FR-18a; spec §6.5/§7.1).
//
// The creative path: a prompt and/or image becomes a GLB mesh via cloud providers, then
// a NEW mesh document (decision 20). The flow, with every external dependency injected
// so it is testable against a fake provider in node (no key, no network) and wired to
// fal + importGltf + projectsStore in the app:
//
//   validate args → resolve provider → check mode↔capability → PAID-JOB CONFIRM GATE
//   → (text→image stage if needed) → submit → poll → fetch GLB → validate GLB
//   → base64 → persist as a mesh document.
//
// Atomicity (§8 "no doc corruption"): the GLB is fetched AND validated (importGltf —
// throws on no geometry) BEFORE anything is persisted. A decline at the gate, a missing
// capability, a failed/timed-out job, or a fetch/parse error all return a structured
// result and persist nothing. Paid jobs are counted only for billable calls actually
// made, and only after the user confirms (FR-18a).

import { z } from "zod";
import type { MeshDoc } from "../../store/types.js";
import type {
  GenImage,
  ImageGenProvider,
  MeshGenJob,
  MeshGenMode,
  MeshGenProvider,
  MeshGenRequest,
} from "../meshgen/types.js";

/** What the model emits for a `create_mesh` call (§7.1). */
const createMeshArgsSchema = z.object({
  mode: z.enum(["text2img3d", "img3d", "text3d"]),
  prompt: z.string().min(1).optional(),
  imageId: z.string().min(1).optional(),
  providerId: z.string().min(1),
  quality: z.string().optional(),
});

/** Disclosed to the user before a billable operation runs (the confirm dialog). */
export interface PaidJobInfo {
  mode: MeshGenMode;
  providerId: string;
  /** Billable calls this operation will make (image-gen + 3D-gen). */
  billableCalls: number;
}

/** One-click paid-job confirmation gate (FR-18a). Resolves true to proceed. */
export type ConfirmPaidJob = (info: PaidJobInfo) => Promise<boolean>;

export interface CreateMeshResult {
  status: "ok" | "error" | "cancelled";
  /** Id of the persisted mesh document (only when status === "ok"). */
  meshDocId?: string;
  /** Short user-facing message (also returned to the model as the tool result). */
  message: string;
  /** Structured failure detail for the model to self-correct. */
  errors?: string;
}

export interface CreateMeshDeps {
  /** Paid-job confirm gate — shown before any billable call (FR-18a). */
  confirm: ConfirmPaidJob;
  /** Resolve the selected 3D-gen provider by id (decision 6; no default). */
  resolveMeshProvider: (id: string) => MeshGenProvider | undefined;
  /** Image-gen provider for the text→image stage of text2img3d. */
  imageProvider?: ImageGenProvider;
  /** Resolve a user-attached image by id (the img3d input). */
  resolveImage?: (imageId: string) => Promise<GenImage>;
  /** Download the produced GLB bytes. */
  fetchGlb: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  /** Validate the GLB parses to real geometry before persisting (app: importGltf). */
  validateGlb: (glb: ArrayBuffer) => Promise<void>;
  /** Persist the mesh document as a new project; returns its id. */
  persist: (doc: MeshDoc) => Promise<string>;
  /** Count one billable call against the usage meter (after the gate). */
  recordPaidJob: () => void;
  /** Poll backoff (tests inject an instant resolver). Default real setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Max poll attempts before timing out (default 150 ≈ 5 min at 2s). */
  maxPolls?: number;
  /** Cancels the whole operation at the next boundary. */
  signal?: AbortSignal;
}

/** Billable call count for a mode: text2img3d runs image-gen + 3D-gen, the rest one. */
function billableCalls(mode: MeshGenMode): number {
  return mode === "text2img3d" ? 2 : 1;
}

/** A short project name from the prompt (or a neutral default). */
function deriveName(prompt: string | undefined): string {
  const p = prompt?.trim();
  if (!p) return "Generated mesh";
  return p.length > 48 ? `${p.slice(0, 48).trimEnd()}…` : p;
}

/** Encode GLB bytes to base64 in chunks (a single fromCharCode(...bytes) overflows the
 * call stack on multi-MB models). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run the create_mesh tool. Validates the request, gates on the paid-job confirm,
 * generates/ingests a GLB, and persists a new mesh document — or returns a structured
 * error/cancellation having persisted nothing.
 */
export async function createMesh(input: unknown, deps: CreateMeshDeps): Promise<CreateMeshResult> {
  const parsed = createMeshArgsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "The create_mesh arguments did not validate.",
      errors: parsed.error.issues
        .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  const { mode, prompt, imageId, providerId, quality } = parsed.data;

  const provider = deps.resolveMeshProvider(providerId);
  if (!provider) {
    return { status: "error", message: `No 3D-generation provider with id '${providerId}'.` };
  }

  // Mode ↔ capability + required inputs (clean error so the model can re-route).
  if (mode === "text3d") {
    if (!provider.supports.text3d) {
      return { status: "error", message: `Provider '${providerId}' does not support direct text→3D — pick a text3d-capable provider or use text2img3d.` };
    }
    if (!prompt) return { status: "error", message: "mode 'text3d' requires a prompt." };
  } else if (mode === "img3d") {
    if (!provider.supports.img3d) {
      return { status: "error", message: `Provider '${providerId}' does not support image→3D.` };
    }
    if (!imageId) return { status: "error", message: "mode 'img3d' requires an imageId." };
    if (!deps.resolveImage) return { status: "error", message: "No image resolver is available for img3d." };
  } else {
    // text2img3d: generate an image, then image→3D.
    if (!provider.supports.img3d) {
      return { status: "error", message: `Provider '${providerId}' does not support image→3D (needed for the 3D stage of text2img3d).` };
    }
    if (!prompt) return { status: "error", message: "mode 'text2img3d' requires a prompt." };
    if (!deps.imageProvider) return { status: "error", message: "No image-generation provider is configured for text2img3d." };
  }

  // FR-18a paid-job confirm gate — before any billable call.
  const approved = await deps.confirm({ mode, providerId, billableCalls: billableCalls(mode) });
  if (!approved) {
    return { status: "cancelled", message: "The paid generation job was not confirmed." };
  }

  if (deps.signal?.aborted) return { status: "cancelled", message: "Cancelled before starting." };

  // ---- Billable execution ----
  let image: GenImage | undefined;
  try {
    if (mode === "img3d") {
      image = await deps.resolveImage!(imageId!);
    } else if (mode === "text2img3d") {
      image = await deps.imageProvider!.generate(prompt!, deps.signal);
      deps.recordPaidJob(); // the image-gen call is billable
    }
  } catch (e) {
    return { status: "error", message: "The image stage failed.", errors: errMessage(e) };
  }

  const req: MeshGenRequest = {
    ...(prompt && mode !== "img3d" ? { prompt } : {}),
    ...(image ? { image } : {}),
    ...(quality ? { quality } : {}),
  };

  let job: MeshGenJob;
  try {
    job = await provider.submit(req, deps.signal);
    deps.recordPaidJob(); // the 3D-gen submission is billable
  } catch (e) {
    return { status: "error", message: "The 3D-generation job could not be submitted.", errors: errMessage(e) };
  }

  // Poll until terminal, bounded by maxPolls and the abort signal (no webhook).
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const interval = deps.pollIntervalMs ?? 2000;
  const maxPolls = deps.maxPolls ?? 150;
  let glbUrl: string | undefined;
  for (let i = 0; i < maxPolls; i++) {
    if (deps.signal?.aborted) return { status: "cancelled", message: "Cancelled while waiting for the 3D job." };
    let status;
    try {
      status = await provider.poll(job, deps.signal);
    } catch (e) {
      return { status: "error", message: "Polling the 3D job failed.", errors: errMessage(e) };
    }
    if (status.state === "succeeded") {
      glbUrl = status.glbUrl;
      break;
    }
    if (status.state === "failed") {
      return { status: "error", message: "The 3D-generation job failed.", errors: status.error };
    }
    await delay(interval);
  }
  if (!glbUrl) {
    return { status: "error", message: `The 3D job did not complete within ${maxPolls} polls (timed out).` };
  }

  // Fetch + validate BEFORE persisting (no doc corruption on a bad/empty GLB).
  let glb: ArrayBuffer;
  try {
    glb = await deps.fetchGlb(glbUrl, deps.signal);
  } catch (e) {
    return { status: "error", message: "Downloading the generated GLB failed.", errors: errMessage(e) };
  }
  try {
    await deps.validateGlb(glb);
  } catch (e) {
    return { status: "error", message: "The generated GLB contained no usable mesh geometry.", errors: errMessage(e) };
  }

  const doc: MeshDoc = {
    kind: "mesh",
    name: deriveName(prompt),
    glb: arrayBufferToBase64(glb),
    source: {
      mode,
      providerId,
      ...(prompt ? { prompt } : {}),
      ...(imageId ? { imageId } : {}),
    },
  };

  let meshDocId: string;
  try {
    meshDocId = await deps.persist(doc);
  } catch (e) {
    return { status: "error", message: "Saving the generated mesh document failed.", errors: errMessage(e) };
  }

  return { status: "ok", meshDocId, message: `Generated a mesh document (${doc.name}).` };
}
