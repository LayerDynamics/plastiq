// @plastiq/capture — capturePointCloud / completePartialScan: submit → poll → result over a
// scripted fake fetch (no network). Mirrors the service contract (services/capture/app/main.py):
// POST /capture|/complete → GET /jobs/{id}/status until "completed" → GET /jobs/{id}/result.
// The service has no auth, so (unlike @plastiq/nerf) there is no header plumbing to assert.

import { describe, expect, it } from "vitest";
import { cancelJob, capturePointCloud, completePartialScan } from "./index.js";

const RESULT_WIRE = { glb_base64: "Z2xURg==", vertices: 512, faces: 1020 };

/** A tiny valid oriented cloud (the client does not enforce the server's 16-point floor — the
 * server owns that 400; callers pre-check with MIN_POINTS). */
const CLOUD = {
  points: [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
  ],
  normals: [
    [0, 0, 1],
    [0, 1, 0],
    [1, 0, 0],
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A fetch that walks submit → status(running)×N → status(completed) → result, recording every
 * URL + its RequestInit and the parsed submit body so tests can assert the wire contract
 * (paths, snake_case body). */
function scriptedFetch(opts: { submitPath?: string; runningPolls?: number; result?: unknown } = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
  inits: (RequestInit | undefined)[];
  submitBody: () => Record<string, unknown> | undefined;
} {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let body: Record<string, unknown> | undefined;
  let statusHits = 0;
  const submitPath = opts.submitPath ?? "/capture";
  const running = opts.runningPolls ?? 1;
  const result = opts.result ?? RESULT_WIRE;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    if (url.endsWith(submitPath)) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "job-3", state: "queued" });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-3", state: statusHits > running ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, inits, submitBody: () => body };
}

describe("capturePointCloud (POST /capture)", () => {
  it("submits, polls until completed, and maps the wire result to { glb, report }", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch({ runningPolls: 2 });
    const states: string[] = [];
    const res = await capturePointCloud(CLOUD, {
      baseURL: "http://localhost:8001/",
      fetchImpl,
      delay: async () => {},
      onState: (s) => states.push(s),
    });
    expect(res.glb).toBe("Z2xURg==");
    expect(res.report.vertices).toBe(512);
    expect(res.report.faces).toBe(1020);
    expect(states).toContain("running");
    expect(states).toContain("completed");
    // trailing slash on the base URL is normalized (no //capture) + the /jobs/{id}/ poll shape
    expect(calls[0]).toBe("http://localhost:8001/capture");
    expect(calls).toContain("http://localhost:8001/jobs/job-3/status");
    expect(calls).toContain("http://localhost:8001/jobs/job-3/result");
    expect((inits[0]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("fires onJob with the submitted job id before polling (cancel handle)", async () => {
    const { fetchImpl } = scriptedFetch();
    const ids: string[] = [];
    await capturePointCloud(CLOUD, {
      fetchImpl,
      delay: async () => {},
      onJob: (id) => ids.push(id),
    });
    expect(ids).toEqual(["job-3"]);
  });

  it("sends the snake_case wire body: points + normals, grid_res/iters only when set", async () => {
    const { fetchImpl, submitBody } = scriptedFetch();
    await capturePointCloud({ ...CLOUD, iters: 900, gridRes: 96 }, { fetchImpl, delay: async () => {} });
    const body = submitBody();
    expect(body?.points).toEqual(CLOUD.points);
    expect(body?.normals).toEqual(CLOUD.normals);
    expect(body?.iters).toBe(900);
    expect(body?.grid_res).toBe(96);

    const bare = scriptedFetch();
    await capturePointCloud(CLOUD, { fetchImpl: bare.fetchImpl, delay: async () => {} });
    expect(bare.submitBody()).toEqual({ points: CLOUD.points, normals: CLOUD.normals });
  });

  it("surfaces the server's 400 validation detail from submit", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ detail: "points and normals must both be Nx3 and the same length" }, false, 400)) as unknown as typeof fetch;
    await expect(capturePointCloud(CLOUD, { fetchImpl, delay: async () => {} })).rejects.toThrow(
      /capture submit: HTTP 400.*Nx3 and the same length/,
    );
  });

  it("throws with the backend error on a failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/capture")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "marching cubes found no surface" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(capturePointCloud(CLOUD, { fetchImpl, delay: async () => {} })).rejects.toThrow(
      /capture failed: marching cubes found no surface/,
    );
  });

  it("surfaces the result endpoint's failure relay (HTTP 500 with the job error as detail)", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/capture")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "completed" });
      if (url.endsWith("/result")) return jsonResponse({ detail: "capture failed" }, false, 500);
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(capturePointCloud(CLOUD, { fetchImpl, delay: async () => {} })).rejects.toThrow(
      /capture result: HTTP 500 — capture failed/,
    );
  });

  it("times out after maxPolls when the job never completes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/capture")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(capturePointCloud(CLOUD, { fetchImpl, delay: async () => {}, maxPolls: 3 })).rejects.toThrow(
      /capture timed out after 3 polls/,
    );
  });

  it("aborts between polls with an AbortError (DOMException)", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/capture")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    const pending = capturePointCloud(CLOUD, {
      fetchImpl,
      signal: controller.signal,
      // Abort while the client waits out a poll interval — the loop must notice on wake.
      delay: async () => controller.abort(),
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws when submit returns no job id", async () => {
    const fetchImpl = (async () => jsonResponse({ state: "queued" })) as unknown as typeof fetch;
    await expect(capturePointCloud(CLOUD, { fetchImpl, delay: async () => {} })).rejects.toThrow(
      /capture: submit returned no job id/,
    );
  });
});

describe("completePartialScan (POST /complete)", () => {
  it("submits points (+grid_res) to /complete, polls, and returns the GLB result", async () => {
    const { fetchImpl, calls, submitBody } = scriptedFetch({
      submitPath: "/complete",
      result: { ...RESULT_WIRE, demo_weights: true },
    });
    const res = await completePartialScan(
      { points: CLOUD.points, gridRes: 48 },
      { fetchImpl, delay: async () => {} },
    );
    expect(res.glb).toBe("Z2xURg==");
    expect(res.report).toEqual({ vertices: 512, faces: 1020, demoWeights: true });
    expect(calls[0]).toBe("http://localhost:8001/complete");
    expect(calls).toContain("http://localhost:8001/jobs/job-3/status");
    // No normals key at all on the completion body — the endpoint takes positions only.
    expect(submitBody()).toEqual({ points: CLOUD.points, grid_res: 48 });
  });

  it("throws with the backend error on a failed completion job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/complete")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "checkpoint missing" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(
      completePartialScan({ points: CLOUD.points }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/completion failed: checkpoint missing/);
  });

  it("aborts a pending completion between polls", async () => {
    const controller = new AbortController();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/complete")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      completePartialScan(
        { points: CLOUD.points },
        { fetchImpl, signal: controller.signal, delay: async () => controller.abort() },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out after maxPolls when the completion job never finishes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/complete")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      completePartialScan({ points: CLOUD.points }, { fetchImpl, delay: async () => {}, maxPolls: 2 }),
    ).rejects.toThrow(/completion timed out after 2 polls/);
  });
});

describe("cancelJob (DELETE /jobs/{id})", () => {
  it("issues DELETE and accepts 204", async () => {
    const calls: string[] = [];
    const methods: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      methods.push(init?.method ?? "GET");
      return { ok: true, status: 204, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    await cancelJob("job-9", { baseURL: "http://localhost:8001", fetchImpl });
    expect(calls[0]).toBe("http://localhost:8001/jobs/job-9");
    expect(methods[0]).toBe("DELETE");
  });

  it("treats 404 as success (idempotent cancel)", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404, json: async () => ({ detail: "no such job" }) }) as unknown as Response) as unknown as typeof fetch;
    await expect(cancelJob("gone", { fetchImpl })).resolves.toBeUndefined();
  });
});
