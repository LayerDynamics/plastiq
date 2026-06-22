// SPEC-6 R6.6 — reconstruction client: submit → poll → result over a scripted fake fetch
// (no network), plus the STEP → CadDocument wrapper.

import { describe, expect, it } from "vitest";
import { reconstructMesh, stepToImportDocument, type ReconstructResult } from "./reconstruct.js";

const REPORT = {
  triangles_in: 12,
  triangles_used: 12,
  faces_built: 6,
  planar_faces: 6,
  is_solid: true,
  is_valid: true,
  method: "fitted",
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A fetch that walks submit → status(running) → status(completed) → result. */
function scriptedFetch(opts: { runningPolls?: number; result?: ReconstructResult } = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let statusHits = 0;
  const running = opts.runningPolls ?? 1;
  const result = opts.result ?? { step: "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;", report: REPORT };
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/reconstruct")) return jsonResponse({ id: "job-1", state: "queued" });
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-1", state: statusHits > running ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("reconstructMesh (SPEC-6 R6.6)", () => {
  it("submits, polls until completed, and returns the STEP + report", async () => {
    const { fetchImpl, calls } = scriptedFetch({ runningPolls: 2 });
    const states: string[] = [];
    const res = await reconstructMesh("Z2xULi4u", {
      baseURL: "http://localhost:8000/",
      fetchImpl,
      delay: async () => {},
      onState: (s) => states.push(s),
    });
    expect(res.report.method).toBe("fitted");
    expect(res.report.is_solid).toBe(true);
    expect(res.step).toMatch(/ISO-10303-21/);
    expect(states).toContain("running");
    expect(states).toContain("completed");
    // base URL trailing slash is normalized (no //reconstruct)
    expect(calls[0]).toBe("http://localhost:8000/reconstruct");
  });

  it("preserves the surface_deviation / fidelity_tol fidelity fields (M1)", async () => {
    const result: ReconstructResult = {
      step: "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
      report: { ...REPORT, surface_deviation: 0.0041, fidelity_tol: 0.01 },
    };
    const { fetchImpl } = scriptedFetch({ runningPolls: 1, result });
    const res = await reconstructMesh("x", { fetchImpl, delay: async () => {} });
    expect(res.report.surface_deviation).toBeCloseTo(0.0041);
    expect(res.report.fidelity_tol).toBe(0.01);
  });

  it("throws with the backend detail on a failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "OCCT sewing blew up" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(
      reconstructMesh("x", { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/reconstruction failed: OCCT sewing blew up/);
  });

  it("surfaces an HTTP error (with detail) from submit", async () => {
    const fetchImpl = (async () => jsonResponse({ detail: "invalid base64 GLB" }, false, 400)) as unknown as typeof fetch;
    await expect(reconstructMesh("x", { fetchImpl, delay: async () => {} })).rejects.toThrow(/HTTP 400.*invalid base64/);
  });

  it("times out after maxPolls when the job never completes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      reconstructMesh("x", { fetchImpl, delay: async () => {}, maxPolls: 3 }),
    ).rejects.toThrow(/timed out after 3 polls/);
  });
});

describe("stepToImportDocument", () => {
  it("wraps STEP as a single importStep feature document", () => {
    const doc = stepToImportDocument("ISO-10303-21;...", "My Part");
    expect(doc.features).toHaveLength(1);
    expect(doc.features[0]!.type).toBe("importStep");
    expect(doc.features[0]!.name).toBe("My Part");
    expect(doc.features[0]!.data).toEqual({ step: "ISO-10303-21;..." });
    expect(doc.params).toEqual({});
  });
});
