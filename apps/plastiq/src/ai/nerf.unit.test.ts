// SPEC-11 N11.3 — the app-side NeRF capture adapter: GLB → MeshDoc mapping + the capture orchestrator
// (trainNerf → MeshDoc → persist), over a scripted fake fetch (no network, no server).

import { describe, expect, it } from "vitest";
import { captureFromPhotos, nerfResultToMeshDoc } from "./nerf.js";
import type { MeshDoc } from "../store/types.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** submit → status(running) → status(completed) → result, returning the given wire result. */
function scriptedFetch(result: unknown): typeof fetch {
  let statusHits = 0;
  return (async (url: string) => {
    if (url.endsWith("/train")) return jsonResponse({ id: "job-1", state: "queued" });
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-1", state: statusHits > 1 ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
}

describe("nerfResultToMeshDoc", () => {
  it("wraps a GLB as a photos3d mesh document", () => {
    const doc = nerfResultToMeshDoc("Z2xURg==", "My capture");
    expect(doc.kind).toBe("mesh");
    expect(doc.glb).toBe("Z2xURg==");
    expect(doc.name).toBe("My capture");
    expect(doc.source.mode).toBe("photos3d");
    expect(doc.source.providerId).toBe("nerf");
  });
});

describe("captureFromPhotos", () => {
  it("trains, maps the GLB to a MeshDoc, persists it, and returns the report", async () => {
    const wire = { glb_base64: "R0xCYWFh", vertices: 100, faces: 200, psnr: 22.2, method: "neus", iters: 500 };
    let persisted: MeshDoc | null = null;
    const states: string[] = [];

    const res = await captureFromPhotos(
      { transformsJson: '{"frames":[]}', images: ["aGk="] },
      {
        persist: async (d) => {
          persisted = d;
          return "mesh-1";
        },
      },
      { fetchImpl: scriptedFetch(wire), delay: async () => {}, onState: (s) => states.push(s) },
      "Captured mesh",
    );

    expect(res.meshDocId).toBe("mesh-1");
    expect(res.report.method).toBe("neus");
    expect(res.report.psnr).toBeCloseTo(22.2);
    expect(res.doc.glb).toBe("R0xCYWFh");
    expect(persisted).not.toBeNull();
    expect((persisted as unknown as MeshDoc).glb).toBe("R0xCYWFh");
    expect((persisted as unknown as MeshDoc).source.mode).toBe("photos3d");
    expect(states).toContain("completed");
  });

  it("propagates a failed training job as a throw (nothing persisted)", async () => {
    const failFetch = (async (url: string) => {
      if (url.endsWith("/train")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "no surface found" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    let persisted = false;
    await expect(
      captureFromPhotos(
        { transformsJson: "{}", images: [] },
        {
          persist: async () => {
            persisted = true;
            return "x";
          },
        },
        { fetchImpl: failFetch, delay: async () => {} },
      ),
    ).rejects.toThrow(/no surface found/);
    expect(persisted).toBe(false);
  });
});
