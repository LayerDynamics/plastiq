// SPEC-6 R4.3 — create_mesh handler: the paid-job confirm gate + the full
// orchestration (mode↔capability checks, image stage, submit→poll, fetch, validate,
// persist), all against a FAKE provider — no key, no network (CI-deterministic). The
// keyed live-fal run lives in createMesh.integration.test.ts (opt-in, not in CI).

import { describe, expect, it } from "vitest";
import { createMesh, type CreateMeshDeps, type PaidJobInfo } from "./createMesh.js";
import type { MeshDoc } from "../../store/types.js";
import type { MeshGenProvider } from "../meshgen/types.js";

/** GLB bytes [1,2,3] → base64 "AQID" (lets us assert the inline encoding). */
const GLB_BYTES = new Uint8Array([1, 2, 3]).buffer;

function fakeMeshProvider(overrides: Partial<MeshGenProvider> = {}): MeshGenProvider {
  return {
    id: "fake:3d",
    label: "Fake 3D",
    supports: { text3d: true, img3d: true },
    submit: async () => ({ id: "job-1" }),
    poll: async () => ({ state: "succeeded", glbUrl: "https://x/model.glb" }),
    ...overrides,
  };
}

interface DepState {
  paidJobs: number;
  confirmInfo: PaidJobInfo | null;
  persisted: MeshDoc | null;
  fetchedUrl: string | null;
}

function makeDeps(over: Partial<CreateMeshDeps> = {}): { deps: CreateMeshDeps; state: DepState } {
  const state: DepState = { paidJobs: 0, confirmInfo: null, persisted: null, fetchedUrl: null };
  const deps: CreateMeshDeps = {
    confirm: async (info) => {
      state.confirmInfo = info;
      return true;
    },
    resolveMeshProvider: () => fakeMeshProvider(),
    imageProvider: { id: "fake:img", label: "Img", generate: async () => ({ mediaType: "image/png", data: "aW1n" }) },
    resolveImage: async () => ({ mediaType: "image/png", data: "dXNlcg==" }),
    fetchGlb: async (url) => {
      state.fetchedUrl = url;
      return GLB_BYTES;
    },
    validateGlb: async () => {},
    persist: async (doc) => {
      state.persisted = doc;
      return "mesh-doc-1";
    },
    recordPaidJob: () => {
      state.paidJobs++;
    },
    delay: async () => {},
    pollIntervalMs: 0,
    ...over,
  };
  return { deps, state };
}

describe("createMesh — paid-job gate + orchestration (SPEC-6 R4.3)", () => {
  it("text3d happy path: confirms, submits, polls, validates, and persists a mesh doc", async () => {
    const { deps, state } = makeDeps();
    const res = await createMesh({ mode: "text3d", prompt: "a gear", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("ok");
    expect(res.meshDocId).toBe("mesh-doc-1");
    expect(state.paidJobs).toBe(1); // only the 3D submit is billable
    expect(state.confirmInfo).toEqual({ mode: "text3d", providerId: "fake:3d", billableCalls: 1 });
    expect(state.persisted).toMatchObject({
      kind: "mesh",
      glb: "AQID", // base64 of [1,2,3] — the GLB is inlined
      source: { mode: "text3d", providerId: "fake:3d", prompt: "a gear" },
    });
  });

  it("the paid-job gate BLOCKS the job until confirmed (no submit, no persist, no charge)", async () => {
    let submitted = false;
    const { deps, state } = makeDeps({
      confirm: async () => false,
      resolveMeshProvider: () =>
        fakeMeshProvider({
          submit: async () => {
            submitted = true;
            return { id: "j" };
          },
        }),
    });
    const res = await createMesh({ mode: "text3d", prompt: "a gear", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("cancelled");
    expect(submitted).toBe(false);
    expect(state.persisted).toBeNull();
    expect(state.paidJobs).toBe(0);
  });

  it("text2img3d runs the image stage then 3D, counting two billable calls", async () => {
    let imageGenCalled = false;
    const { deps, state } = makeDeps({
      imageProvider: {
        id: "i",
        label: "i",
        generate: async () => {
          imageGenCalled = true;
          return { mediaType: "image/png", data: "aW1n" };
        },
      },
    });
    const res = await createMesh({ mode: "text2img3d", prompt: "a vase", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("ok");
    expect(imageGenCalled).toBe(true);
    expect(state.paidJobs).toBe(2); // image-gen + 3D submit
    expect(state.confirmInfo!.billableCalls).toBe(2);
    expect(state.persisted!.source).toMatchObject({ mode: "text2img3d", prompt: "a vase" });
  });

  it("text2img3d threads the SELECTED image provider into the image stage (not a hardwired one)", async () => {
    let usedProviderId: string | null = null;
    const selected: CreateMeshDeps["imageProvider"] = {
      id: "fal:flux-dev",
      label: "FLUX dev",
      generate: async () => {
        usedProviderId = "fal:flux-dev"; // the id of THIS provider — proves selection flows through
        return { mediaType: "image/png", data: "aW1n" };
      },
    };
    const { deps, state } = makeDeps({ imageProvider: selected });
    const res = await createMesh({ mode: "text2img3d", prompt: "a vase", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("ok");
    expect(usedProviderId).toBe("fal:flux-dev"); // the picked model ran text→image, not a default
    expect(state.paidJobs).toBe(2);
  });

  it("text2img3d errors when no image provider resolved (e.g. an unknown persisted id) — the 3D path", async () => {
    const { deps, state } = makeDeps({ imageProvider: undefined });
    const res = await createMesh({ mode: "text2img3d", prompt: "a vase", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/No image-generation provider/);
    expect(state.persisted).toBeNull();
    expect(state.paidJobs).toBe(0);
  });

  it("img3d resolves the attached image and does NOT call the image-gen provider", async () => {
    let imageGenCalled = false;
    const { deps, state } = makeDeps({
      imageProvider: {
        id: "i",
        label: "i",
        generate: async () => {
          imageGenCalled = true;
          return { mediaType: "image/png", data: "x" };
        },
      },
    });
    const res = await createMesh({ mode: "img3d", imageId: "img-7", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("ok");
    expect(imageGenCalled).toBe(false);
    expect(state.paidJobs).toBe(1); // only the 3D submit is billable here
    expect(state.persisted!.source).toMatchObject({ mode: "img3d", imageId: "img-7" });
  });

  it("errors BEFORE the gate when the provider lacks the requested mode", async () => {
    let confirmed = false;
    const { deps } = makeDeps({
      confirm: async () => {
        confirmed = true;
        return true;
      },
      resolveMeshProvider: () => fakeMeshProvider({ supports: { text3d: false, img3d: true } }),
    });
    const res = await createMesh({ mode: "text3d", prompt: "x", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/does not support direct text→3D/);
    expect(confirmed).toBe(false); // never reached the paid gate
  });

  it("img3d requires an imageId", async () => {
    const { deps } = makeDeps();
    const res = await createMesh({ mode: "img3d", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/requires an imageId/);
  });

  it("errors when the selected provider id is unknown", async () => {
    const { deps } = makeDeps({ resolveMeshProvider: () => undefined });
    const res = await createMesh({ mode: "text3d", prompt: "x", providerId: "nope" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/No 3D-generation provider/);
  });

  it("a failed job returns an error and persists nothing (the submit was still billed)", async () => {
    const { deps, state } = makeDeps({
      resolveMeshProvider: () => fakeMeshProvider({ poll: async () => ({ state: "failed", error: "OOM on the GPU" }) }),
    });
    const res = await createMesh({ mode: "text3d", prompt: "x", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.errors).toMatch(/OOM/);
    expect(state.persisted).toBeNull();
    expect(state.paidJobs).toBe(1);
  });

  it("a GLB that fails validation is NOT persisted (no doc corruption)", async () => {
    const { deps, state } = makeDeps({
      validateGlb: async () => {
        throw new Error("glTF/GLB contained no mesh geometry");
      },
    });
    const res = await createMesh({ mode: "text3d", prompt: "x", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/no usable mesh geometry/);
    expect(state.persisted).toBeNull();
  });

  it("times out after maxPolls when the job never completes", async () => {
    const { deps, state } = makeDeps({
      maxPolls: 3,
      resolveMeshProvider: () => fakeMeshProvider({ poll: async () => ({ state: "running", progress: 0.5 }) }),
    });
    const res = await createMesh({ mode: "text3d", prompt: "x", providerId: "fake:3d" }, deps);
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/timed out/);
    expect(state.persisted).toBeNull();
  });

  it("fetches the GLB from the URL the job reported", async () => {
    const { deps, state } = makeDeps({
      resolveMeshProvider: () =>
        fakeMeshProvider({ poll: async () => ({ state: "succeeded", glbUrl: "https://cdn/abc.glb" }) }),
    });
    await createMesh({ mode: "text3d", prompt: "x", providerId: "fake:3d" }, deps);
    expect(state.fetchedUrl).toBe("https://cdn/abc.glb");
  });

  it("rejects malformed arguments (zod)", async () => {
    const { deps } = makeDeps();
    const res = await createMesh({ mode: "text3d" }, deps); // no providerId
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/did not validate/);
  });
});
