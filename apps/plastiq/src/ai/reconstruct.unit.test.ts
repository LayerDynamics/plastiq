// SPEC-6 R6.6 — reconstruction client: submit → poll → result over a scripted fake fetch
// (no network), plus the STEP → CadDocument wrapper and cancelReconstruct (M4b).

import { beforeEach, describe, expect, it } from "vitest";
import {
  cancelReconstruct,
  reconstructMesh,
  stepToImportDocument,
  type ReconstructResult,
} from "./reconstruct.js";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";

const REPORT = {
  triangles_in: 12,
  triangles_used: 12,
  faces_built: 6,
  planar_faces: 6,
  is_solid: true,
  is_valid: true,
  method: "fitted",
};

const BASE_SETTINGS: AiSettings = { providerKey: "anthropic", providerId: "anthropic", model: "m", apiKeys: {} };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Authorization header of a recorded request (plain-object headers). */
function authOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
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

beforeEach(() => {
  useAiStore.setState({ settings: null, loaded: false });
});

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

  it("sends the requested method in the submit body (SPEC-7 FR-11)", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/reconstruct")) {
        bodies.push(String(init?.body));
        return jsonResponse({ id: "j", state: "queued" });
      }
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "completed" });
      if (url.endsWith("/result")) {
        return jsonResponse({ step: "ISO-10303-21;", report: { ...REPORT, method: "faceted" } });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    const res = await reconstructMesh("Z2xULi4u", { fetchImpl, delay: async () => {}, method: "faceted" });
    expect(JSON.parse(bodies[0]!)).toEqual({ glb_base64: "Z2xULi4u", method: "faceted" });
    expect(res.report.method).toBe("faceted");
  });

  it("omits method from the submit body when not specified (server default: auto)", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/reconstruct")) {
        bodies.push(String(init?.body));
        return jsonResponse({ id: "j", state: "queued" });
      }
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "completed" });
      if (url.endsWith("/result")) return jsonResponse({ step: "ISO-10303-21;", report: REPORT });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    await reconstructMesh("Z2xULi4u", { fetchImpl, delay: async () => {} });
    expect(JSON.parse(bodies[0]!)).toEqual({ glb_base64: "Z2xULi4u" });
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

  it("exposes the submitted job id via onJob before polling (the cancelReconstruct handle)", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const ids: string[] = [];
    await reconstructMesh("x", { fetchImpl, delay: async () => {}, onJob: (id) => ids.push(id) });
    expect(ids).toEqual(["job-1"]);
    expect(calls[1]).toBe("http://localhost:8000/jobs/job-1/status");
  });

  it("threads persisted reconstructApiKey; a caller-supplied opts.apiKey wins", async () => {
    const bodies: RequestInit[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      bodies.push(init ?? {});
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "completed" });
      if (url.endsWith("/result")) return jsonResponse({ step: "ISO-10303-21;", report: REPORT });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    useAiStore.setState({ settings: { ...BASE_SETTINGS, reconstructApiKey: "recon-secret" }, loaded: true });
    await reconstructMesh("x", { fetchImpl, delay: async () => {} });
    expect(authOf(bodies[0])).toBe("Bearer recon-secret");

    await reconstructMesh("x", { fetchImpl, delay: async () => {}, apiKey: "explicit-key" });
    // Second job's submit is at index 3 (submit/status/result ×1 already ran)
    expect(authOf(bodies[3])).toBe("Bearer explicit-key");
  });
});

describe("cancelReconstruct — server-side job cancel (M4b)", () => {
  function deleteFetch(status = 204): { fetchImpl: typeof fetch; reqs: { url: string; init?: RequestInit }[] } {
    const reqs: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      reqs.push({ url, init });
      return jsonResponse({}, status >= 200 && status < 300, status);
    }) as unknown as typeof fetch;
    return { fetchImpl, reqs };
  }

  it("DELETEs /jobs/{id}, threading the persisted reconstructApiKey as the bearer header", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, reconstructApiKey: "recon-secret" }, loaded: true });
    const { fetchImpl, reqs } = deleteFetch();
    await cancelReconstruct("job-9", { fetchImpl });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.url).toBe("http://localhost:8000/jobs/job-9");
    expect(reqs[0]?.init?.method).toBe("DELETE");
    expect(authOf(reqs[0]?.init)).toBe("Bearer recon-secret");
  });

  it("a caller-supplied opts.apiKey wins over the persisted setting", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, reconstructApiKey: "from-settings" }, loaded: true });
    const { fetchImpl, reqs } = deleteFetch();
    await cancelReconstruct("job-9", { fetchImpl, apiKey: "explicit-key" });
    expect(authOf(reqs[0]?.init)).toBe("Bearer explicit-key");
  });

  it("sends no header when keyless and tolerates a 404 (job already gone — no throw)", async () => {
    const { fetchImpl, reqs } = deleteFetch(404);
    await expect(cancelReconstruct("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(authOf(reqs[0]?.init)).toBeUndefined();
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
