// SPEC-6 R4.4 — attachment routing (FR-10a/FR-10b, Risk R-9). An attached image can
// drive the PARAMETRIC path (vision → build_part) or the CREATIVE path (→ create_mesh).
// Parametric-vision requires a vision-capable model; the creative path never does.

import { describe, expect, it } from "vitest";
import { planAttachmentRoute, type AttachmentInput } from "./visionRoute.js";
import type { ImagePart } from "./providers/types.js";

const baseInput = (over: Partial<AttachmentInput> = {}): AttachmentInput => ({
  route: "parametric",
  prompt: "make this bracket 5mm thick",
  image: { mediaType: "image/png", data: "aW1nQnl0ZXM=" },
  imageId: "img-1",
  supportsVision: true,
  ...over,
});

describe("planAttachmentRoute (SPEC-6 R4.4)", () => {
  it("parametric + vision-capable: the image reaches build_part as an image content part", () => {
    const plan = planAttachmentRoute(baseInput());
    expect(plan.kind).toBe("parametric");
    if (plan.kind !== "parametric") throw new Error("expected parametric");
    expect(plan.userContent[0]).toEqual({ type: "text", text: "make this bracket 5mm thick" });
    const imgPart = plan.userContent[1] as ImagePart;
    expect(imgPart).toEqual({ type: "image", mediaType: "image/png", data: "aW1nQnl0ZXM=" });
  });

  it("parametric on a NON-vision model: the route is disabled with guidance (not silent)", () => {
    const plan = planAttachmentRoute(baseInput({ supportsVision: false }));
    expect(plan.kind).toBe("disabled");
    if (plan.kind !== "disabled") throw new Error("expected disabled");
    expect(plan.reason).toMatch(/vision-capable|can.t see images/i);
    expect(plan.reason).toMatch(/Generate mesh/i); // points the user at the creative route
  });

  it("creative: the image is routed to create_mesh (img3d), no LLM vision required", () => {
    const plan = planAttachmentRoute(baseInput({ route: "creative" }));
    expect(plan.kind).toBe("creative");
    if (plan.kind !== "creative") throw new Error("expected creative");
    expect(plan.createMeshInput.mode).toBe("img3d");
    expect(plan.createMeshInput.imageId).toBe("img-1");
    expect(plan.createMeshInput.prompt).toBe("make this bracket 5mm thick");
  });

  it("creative works even on a non-vision model (the LLM never sees the image)", () => {
    const plan = planAttachmentRoute(baseInput({ route: "creative", supportsVision: false }));
    expect(plan.kind).toBe("creative");
  });

  it("creative omits an empty prompt from the create_mesh input", () => {
    const plan = planAttachmentRoute(baseInput({ route: "creative", prompt: "  " }));
    if (plan.kind !== "creative") throw new Error("expected creative");
    expect(plan.createMeshInput.prompt).toBeUndefined();
  });
});
