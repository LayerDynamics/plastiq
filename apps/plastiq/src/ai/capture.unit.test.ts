// SPEC-10 (browser client) — the app-side capture adapter: GLB → MeshDoc mapping + the two scan
// orchestrators (capturePointCloud/completePartialScan → MeshDoc → persist), over a scripted fake
// fetch (no network, no server). The capture service has no auth (main.py), so — unlike
// nerf.unit.test.ts — there is no key-threading section here.

import { describe, expect, it } from "vitest";
import { captureResultToMeshDoc, meshFromPartialScan, meshFromPointCloud } from "./capture.js";
import type { MeshDoc } from "../store/types.js";

/** 16 oriented points — the server's documented floor (main.py: "need at least 16 points"). */
const POINTS = Array.from({ length: 16 }, (_, i) => [i, i * 2, i * 3]);
const NORMALS = Array.from({ length: 16 }, () => [0, 0, 1]);

const RESULT_WIRE = { glb_base64: "R0xCYWFh", vertices: 100, faces: 200 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** submit → status(running) → status(completed) → result, recording every URL + the submit body
 * so a test can assert the actual HTTP contract (path shape, snake_case body). */
function scriptedFetch(submitPath: string, result: unknown = RESULT_WIRE): {
  fetchImpl: typeof fetch;
  calls: string[];
  submitBody: () => Record<string, unknown> | undefined;
} {
  const calls: string[] = [];
  let body: Record<string, unknown> | undefined;
  let statusHits = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith(submitPath)) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "job-1", state: "queued" });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-1", state: statusHits > 1 ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, submitBody: () => body };
}

describe("captureResultToMeshDoc", () => {
  it("wraps a GLB as a capture-family mesh document, distinguishing the two endpoints", () => {
    const doc = captureResultToMeshDoc("Z2xURg==", "capture", "My scan");
    expect(doc.kind).toBe("mesh");
    expect(doc.glb).toBe("Z2xURg==");
    expect(doc.name).toBe("My scan");
    expect(doc.source.mode).toBe("photos3d");
    expect(doc.source.providerId).toBe("capture");
    expect(captureResultToMeshDoc("Z2xURg==", "capture:complete").source.providerId).toBe("capture:complete");
  });
});

describe("meshFromPointCloud (POST /capture)", () => {
  it("captures, maps the GLB to a MeshDoc, persists it, and returns the report", async () => {
    let persisted: MeshDoc | null = null;
    const states: string[] = [];
    const { fetchImpl, calls, submitBody } = scriptedFetch("/capture");

    const res = await meshFromPointCloud(
      { points: POINTS, normals: NORMALS, gridRes: 64 },
      {
        persist: async (d) => {
          persisted = d;
          return "mesh-1";
        },
      },
      { fetchImpl, delay: async () => {}, onState: (s) => states.push(s) },
      "Scanned mesh",
    );

    expect(res.meshDocId).toBe("mesh-1");
    expect(res.report).toEqual({ vertices: 100, faces: 200 });
    expect(res.doc.glb).toBe("R0xCYWFh");
    expect(persisted).not.toBeNull();
    expect((persisted as unknown as MeshDoc).glb).toBe("R0xCYWFh");
    expect((persisted as unknown as MeshDoc).source.mode).toBe("photos3d");
    expect((persisted as unknown as MeshDoc).source.providerId).toBe("capture");
    expect(states).toContain("completed");

    // the actual HTTP contract: /jobs/{id}/ poll path shape + snake_case submit body
    expect(calls).toContain("http://localhost:8001/capture");
    expect(calls).toContain("http://localhost:8001/jobs/job-1/status");
    expect(calls).toContain("http://localhost:8001/jobs/job-1/result");
    const body = submitBody();
    expect(body?.points).toEqual(POINTS);
    expect(body?.normals).toEqual(NORMALS);
    expect(body?.grid_res).toBe(64);
  });

  it("propagates a failed capture job as a throw (nothing persisted)", async () => {
    const failFetch = (async (url: string) => {
      if (url.endsWith("/capture")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "no surface found" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    let persisted = false;
    await expect(
      meshFromPointCloud(
        { points: POINTS, normals: NORMALS },
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

describe("meshFromPartialScan (POST /complete)", () => {
  it("completes a partial scan into a persisted capture:complete MeshDoc", async () => {
    let persisted: MeshDoc | null = null;
    const { fetchImpl, calls, submitBody } = scriptedFetch("/complete");

    const res = await meshFromPartialScan(
      { points: POINTS },
      {
        persist: async (d) => {
          persisted = d;
          return "mesh-2";
        },
      },
      { fetchImpl, delay: async () => {}, baseURL: "http://scanner.local:8001" },
    );

    expect(res.meshDocId).toBe("mesh-2");
    expect(res.doc.name).toBe("Completed scan");
    expect((persisted as unknown as MeshDoc).source.providerId).toBe("capture:complete");
    // The settings base URL is honored, and the completion body carries points only (no normals).
    expect(calls[0]).toBe("http://scanner.local:8001/complete");
    expect(submitBody()).toEqual({ points: POINTS });
  });
});
