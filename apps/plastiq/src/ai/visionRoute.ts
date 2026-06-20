// SPEC-6 R4.4 — attachment routing (FR-10a/FR-10b, Risk R-9).
//
// The prompt input accepts an image with a route toggle: use it as a PARAMETRIC
// reference (the image informs build_part on a vision-capable model) or GENERATE a mesh
// from it (the creative path → create_mesh, image→3D). This module is the pure routing
// decision: given the chosen route, the active provider's vision capability, and the
// attachment, it returns the plan the GenerationPanel acts on. Parametric-vision is
// gated on `supportsVision` (most local Ollama tool-models cannot see — R-9) and, when
// unavailable, is disabled with guidance rather than silently dropping the image; the
// creative path needs no LLM vision (the image goes straight to the 3D provider).

import type { ContentPart } from "./providers/types.js";
import type { GenImage } from "./meshgen/types.js";

/** The two routes a user can pick for an attached image (FR-10a). */
export type AttachmentRoute = "parametric" | "creative";

export interface AttachmentInput {
  route: AttachmentRoute;
  /** The accompanying text instruction. */
  prompt: string;
  /** The attached image (base64). */
  image: GenImage;
  /** Stable id for the attachment, so the creative route's create_mesh can reference it. */
  imageId: string;
  /** Whether the active ChatProvider can see images (provider.supportsVision; FR-10b). */
  supportsVision: boolean;
}

/** What the GenerationPanel should do with the attachment. */
export type AttachmentPlan =
  /** Run the agent with this user content (text + image part) for build_part. */
  | { kind: "parametric"; userContent: ContentPart[] }
  /** Feed create_mesh with this route-derived input (the panel adds providerId). */
  | { kind: "creative"; createMeshInput: { mode: "img3d"; imageId: string; prompt?: string } }
  /** The parametric route is unavailable on this model; show `reason`, disable it. */
  | { kind: "disabled"; reason: string };

/** Decide how an attached image is used, given the route and the model's vision support. */
export function planAttachmentRoute(input: AttachmentInput): AttachmentPlan {
  if (input.route === "creative") {
    // Creative: the image drives create_mesh (image→3D); the LLM never sees it.
    const prompt = input.prompt.trim();
    return {
      kind: "creative",
      createMeshInput: { mode: "img3d", imageId: input.imageId, ...(prompt ? { prompt } : {}) },
    };
  }

  // Parametric: the image is a vision reference for build_part — needs a vision model.
  if (!input.supportsVision) {
    return {
      kind: "disabled",
      reason:
        "The selected model can’t see images. Switch to a vision-capable model (e.g. Claude) to use an image as a parametric reference, or route the image to “Generate mesh”.",
    };
  }

  const userContent: ContentPart[] = [
    { type: "text", text: input.prompt },
    { type: "image", mediaType: input.image.mediaType, data: input.image.data },
  ];
  return { kind: "parametric", userContent };
}
