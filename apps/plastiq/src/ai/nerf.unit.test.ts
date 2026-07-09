// SPEC-11 N11.3 — the app-side NeRF capture adapter: GLB → MeshDoc mapping + the capture orchestrator
// (trainNerf → MeshDoc → persist), over a scripted fake fetch (no network, no server). Also covers
// the SPEC-11 §5 auth seam — the persisted `nerfApiKey` setting is threaded into every request —
// the §5 training knobs (11-L6: method/iters/gridRes/encoding/importanceSamples pass through to the
// snake_case wire body, and are omitted when unset), and the server-side cancel counterpart
// (cancelCapture → DELETE /jobs/{id}, 11-M2).

import { beforeEach, describe, expect, it } from "vitest";
import { cancelCapture, captureFromPhotos, nerfResultToMeshDoc } from "./nerf.js";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";
import type { MeshDoc } from "../store/types.js";

/** Minimal valid settings (the auth tests spread `nerfApiKey` on top). */
const BASE_SETTINGS: AiSettings = { providerKey: "anthropic", providerId: "anthropic", model: "m", apiKeys: {} };

beforeEach(() => {
  // The adapter reads the live store for the auth default — start every test key-less.
  useAiStore.setState({ settings: null, loaded: false });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** submit → status(running) → status(completed) → result, recording every URL + RequestInit + the
 * submit body so a test can assert the actual HTTP contract (path shape, snake_case body, headers). */
function scriptedFetch(result: unknown): {
  fetchImpl: typeof fetch;
  calls: string[];
  inits: (RequestInit | undefined)[];
  submitBody: () => Record<string, unknown> | undefined;
} {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let body: Record<string, unknown> | undefined;
  let statusHits = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    if (url.endsWith("/train")) {
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
  return { fetchImpl, calls, inits, submitBody: () => body };
}

/** The Authorization header of a recorded request (the client sends plain-object headers). */
function authOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
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

    const { fetchImpl, calls, submitBody } = scriptedFetch(wire);
    const res = await captureFromPhotos(
      { transformsJson: '{"frames":[]}', images: ["aGk="] },
      {
        persist: async (d) => {
          persisted = d;
          return "mesh-1";
        },
      },
      { fetchImpl, delay: async () => {}, onState: (s) => states.push(s) },
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

    // the actual HTTP contract: /jobs/{id}/ poll path shape + snake_case submit body
    expect(calls).toContain("http://localhost:8002/jobs/job-1/status");
    expect(calls).toContain("http://localhost:8002/jobs/job-1/result");
    const body = submitBody();
    expect(body?.transforms_json).toBe('{"frames":[]}');
    expect(body?.images).toEqual(["aGk="]);
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

describe("captureFromPhotos — §5 training knobs reach the wire (11-L6)", () => {
  const WIRE = { glb_base64: "R0xC", vertices: 1, faces: 1, psnr: 20, method: "nerf", iters: 1000 };
  const deps = { persist: async (): Promise<string> => "mesh-1" };

  it("threads method/iters/gridRes/encoding/importanceSamples into the snake_case submit body", async () => {
    const { fetchImpl, submitBody } = scriptedFetch(WIRE);
    await captureFromPhotos(
      {
        transformsJson: "{}",
        images: [],
        method: "nerf",
        iters: 1000,
        gridRes: 128,
        encoding: "hashgrid",
        importanceSamples: 64,
      },
      deps,
      { fetchImpl, delay: async () => {} },
    );
    const body = submitBody();
    expect(body?.method).toBe("nerf");
    expect(body?.iters).toBe(1000);
    expect(body?.grid_res).toBe(128);
    expect(body?.encoding).toBe("hashgrid");
    expect(body?.importance_samples).toBe(64);
  });

  it("omits every knob the caller leaves unset — the server's own defaults apply", async () => {
    const { fetchImpl, submitBody } = scriptedFetch(WIRE);
    await captureFromPhotos({ transformsJson: "{}", images: [] }, deps, { fetchImpl, delay: async () => {} });
    const body = submitBody();
    expect(body).toBeDefined();
    for (const key of ["method", "iters", "grid_res", "encoding", "importance_samples"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("captureFromPhotos — nerfApiKey threading (SPEC-11 §5)", () => {
  const WIRE = { glb_base64: "R0xC", vertices: 1, faces: 1, psnr: 20, method: "neus", iters: 100 };
  const deps = { persist: async (): Promise<string> => "mesh-1" };

  it("threads the persisted nerfApiKey setting into EVERY request as a bearer header", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nerfApiKey: "nerf-secret" }, loaded: true });
    const { fetchImpl, calls, inits } = scriptedFetch(WIRE);
    await captureFromPhotos({ transformsJson: "{}", images: [] }, deps, { fetchImpl, delay: async () => {} });
    expect(calls).toHaveLength(4); // train + status×2 + result — all authenticated
    for (const init of inits) expect(authOf(init)).toBe("Bearer nerf-secret");
  });

  it("a caller-supplied opts.apiKey wins over the persisted setting", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nerfApiKey: "from-settings" }, loaded: true });
    const { fetchImpl, inits } = scriptedFetch(WIRE);
    await captureFromPhotos(
      { transformsJson: "{}", images: [] },
      deps,
      { fetchImpl, delay: async () => {}, apiKey: "explicit-key" },
    );
    for (const init of inits) expect(authOf(init)).toBe("Bearer explicit-key");
  });

  it("sends no Authorization header when neither settings nor opts carry a key", async () => {
    const { fetchImpl, inits } = scriptedFetch(WIRE);
    await captureFromPhotos({ transformsJson: "{}", images: [] }, deps, { fetchImpl, delay: async () => {} });
    for (const init of inits) expect(authOf(init)).toBeUndefined();
  });
});

describe("cancelCapture — server-side job cancel (SPEC-11 §5, 11-M2)", () => {
  /** A single-shot fetch answering the DELETE with `status`, recording the request. */
  function deleteFetch(status = 204): { fetchImpl: typeof fetch; reqs: { url: string; init?: RequestInit }[] } {
    const reqs: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      reqs.push({ url, init });
      return jsonResponse({}, status >= 200 && status < 300, status);
    }) as unknown as typeof fetch;
    return { fetchImpl, reqs };
  }

  it("DELETEs /jobs/{id}, threading the persisted nerfApiKey as the bearer header", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nerfApiKey: "nerf-secret" }, loaded: true });
    const { fetchImpl, reqs } = deleteFetch();
    await cancelCapture("job-9", { fetchImpl });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.url).toBe("http://localhost:8002/jobs/job-9");
    expect(reqs[0]?.init?.method).toBe("DELETE");
    expect(authOf(reqs[0]?.init)).toBe("Bearer nerf-secret");
  });

  it("a caller-supplied opts.apiKey wins over the persisted setting", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nerfApiKey: "from-settings" }, loaded: true });
    const { fetchImpl, reqs } = deleteFetch();
    await cancelCapture("job-9", { fetchImpl, apiKey: "explicit-key" });
    expect(authOf(reqs[0]?.init)).toBe("Bearer explicit-key");
  });

  it("sends no header when keyless and tolerates a 404 (job already gone — no throw)", async () => {
    const { fetchImpl, reqs } = deleteFetch(404);
    await expect(cancelCapture("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(authOf(reqs[0]?.init)).toBeUndefined();
  });
});
