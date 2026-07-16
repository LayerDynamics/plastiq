// @plastiq/nerf — trainNerf: submit → poll → result over a scripted fake fetch (no network).
// Mirrors the capture/reconstruct service contract: POST /train → GET /jobs/{id}/status until
// "completed" → GET /jobs/{id}/result. (SPEC-11 N11.)

import { describe, expect, it } from "vitest";
import { cancelJob, trainNerf } from "./client.js";

const RESULT_WIRE = {
  glb_base64: "Z2xURg==",
  vertices: 1280,
  faces: 2496,
  psnr: 24.7,
  method: "neus",
  iters: 1500,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A fetch that walks submit → status(running)×N → status(completed) → result, recording every
 * URL + its RequestInit and the parsed submit body so tests can assert the wire contract
 * (paths, snake_case body, and per-request headers). */
function scriptedFetch(opts: { runningPolls?: number; result?: unknown } = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
  inits: (RequestInit | undefined)[];
  submitBody: () => Record<string, unknown> | undefined;
} {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let body: Record<string, unknown> | undefined;
  let statusHits = 0;
  const running = opts.runningPolls ?? 1;
  const result = opts.result ?? RESULT_WIRE;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    if (url.endsWith("/train")) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "job-7", state: "queued" });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-7", state: statusHits > running ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, inits, submitBody: () => body };
}

/** The Authorization header of a recorded request (all requests use plain-object headers). */
function authOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
}

describe("trainNerf (SPEC-11 N11)", () => {
  it("submits, polls until completed, and maps the wire result to { glb, report }", async () => {
    const { fetchImpl, calls } = scriptedFetch({ runningPolls: 2 });
    const states: string[] = [];
    const res = await trainNerf(
      { transformsJson: '{"frames":[]}', images: ["aGVsbG8="] },
      { baseURL: "http://localhost:8002/", fetchImpl, delay: async () => {}, onState: (s) => states.push(s) },
    );
    expect(res.glb).toBe("Z2xURg==");
    expect(res.report.method).toBe("neus");
    expect(res.report.psnr).toBeCloseTo(24.7);
    expect(res.report.vertices).toBe(1280);
    expect(res.report.faces).toBe(2496);
    expect(res.report.iters).toBe(1500);
    expect(states).toContain("running");
    expect(states).toContain("completed");
    // trailing slash on the base URL is normalized (no //train)
    expect(calls[0]).toBe("http://localhost:8002/train");
  });

  it("stringifies an object transformsJson and forwards images + options on the submit body", async () => {
    const { fetchImpl, submitBody } = scriptedFetch();
    await trainNerf(
      { transformsJson: { camera_angle_x: 0.69, frames: [{ file_path: "0" }] }, images: ["a", "b"], iters: 800, method: "nerf", gridRes: 96 },
      { fetchImpl, delay: async () => {} },
    );
    const body = submitBody();
    expect(body).toBeDefined();
    expect(typeof body!.transforms_json).toBe("string");
    expect(JSON.parse(body!.transforms_json as string)).toEqual({ camera_angle_x: 0.69, frames: [{ file_path: "0" }] });
    expect(body!.images).toEqual(["a", "b"]);
    expect(body!.iters).toBe(800);
    expect(body!.method).toBe("nerf");
    expect(body!.grid_res).toBe(96);
  });

  it("serializes encoding/importanceSamples snake_case when set, and omits them when unset", async () => {
    // Set → snake_case wire fields on the submit body (11-L1).
    const withFields = scriptedFetch();
    await trainNerf(
      { transformsJson: "{}", images: [], method: "nerf", encoding: "hashgrid", importanceSamples: 16 },
      { fetchImpl: withFields.fetchImpl, delay: async () => {} },
    );
    expect(withFields.submitBody()!.encoding).toBe("hashgrid");
    expect(withFields.submitBody()!.importance_samples).toBe(16);

    // Unset → absent entirely (the service's own defaults apply; nothing is sent speculatively).
    const without = scriptedFetch();
    await trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl: without.fetchImpl, delay: async () => {} });
    expect("encoding" in without.submitBody()!).toBe(false);
    expect("importance_samples" in without.submitBody()!).toBe(false);
  });

  it("maps the additive encoding/importance_samples result keys into the report when present", async () => {
    const { fetchImpl } = scriptedFetch({
      result: { ...RESULT_WIRE, method: "nerf", encoding: "hashgrid", importance_samples: 16 },
    });
    const res = await trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {} });
    expect(res.report.encoding).toBe("hashgrid");
    expect(res.report.importanceSamples).toBe(16);

    // An older service that doesn't send them → absent from the report (not defaulted/guessed).
    const older = scriptedFetch(); // RESULT_WIRE has neither key
    const resOld = await trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl: older.fetchImpl, delay: async () => {} });
    expect(resOld.report.encoding).toBeUndefined();
    expect(resOld.report.importanceSamples).toBeUndefined();
  });

  it("defaults the report method to nerf when the server omits/garbles it", async () => {
    const { fetchImpl } = scriptedFetch({ result: { ...RESULT_WIRE, method: "???" } });
    const res = await trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {} });
    expect(res.report.method).toBe("nerf");
  });

  it("throws with the backend detail on a failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/train")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "MLX OOM at 1.5M rays" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(
      trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/nerf training failed: MLX OOM at 1.5M rays/);
  });

  it("surfaces an HTTP error (with detail) from submit", async () => {
    const fetchImpl = (async () => jsonResponse({ detail: "transforms_json and images length mismatch" }, false, 400)) as unknown as typeof fetch;
    await expect(
      trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/nerf submit: HTTP 400.*length mismatch/);
  });

  it("exposes the submitted job id via onJob before polling (the cancelJob handle)", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const ids: string[] = [];
    await trainNerf(
      { transformsJson: "{}", images: [] },
      { fetchImpl, delay: async () => {}, onJob: (id) => ids.push(id) },
    );
    // Fired exactly once, with the id the /jobs/{id}/… polls then use — so a caller holding it
    // mid-training can DELETE the same job the service is running.
    expect(ids).toEqual(["job-7"]);
    expect(calls[1]).toBe("http://localhost:8002/jobs/job-7/status");
  });

  it("times out after maxPolls when the job never completes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/train")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {}, maxPolls: 3 }),
    ).rejects.toThrow(/timed out after 3 polls/);
  });
});

describe("trainNerf auth header (SPEC-11 §5 — NERF_API_KEY deployments)", () => {
  it("sends Authorization: Bearer <key> on EVERY request when apiKey is set", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch({ runningPolls: 2 });
    await trainNerf(
      { transformsJson: "{}", images: [] },
      { fetchImpl, delay: async () => {}, apiKey: "nerf-secret" },
    );
    // submit + status(running)×2 + status(completed) + result — the header rides on all of them
    expect(calls).toHaveLength(5);
    for (const init of inits) expect(authOf(init)).toBe("Bearer nerf-secret");
    // …and the submit request keeps its JSON content type alongside the auth header
    expect((inits[0]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends NO Authorization header when apiKey is absent (the open dev default)", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch();
    await trainNerf({ transformsJson: "{}", images: [] }, { fetchImpl, delay: async () => {} });
    expect(calls.length).toBeGreaterThan(0);
    for (const init of inits) expect(authOf(init)).toBeUndefined();
  });
});

/** A single-shot fetch answering the DELETE with `status`, recording the request for assertions. */
function deleteFetch(status: number, body: unknown = {}): {
  fetchImpl: typeof fetch;
  calls: string[];
  inits: (RequestInit | undefined)[];
} {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    return jsonResponse(body, status >= 200 && status < 300, status);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, inits };
}

describe("cancelJob (SPEC-11 §5 — DELETE /jobs/{id})", () => {
  it("issues DELETE {base}/jobs/{id} (base normalized) and resolves on 204", async () => {
    const { fetchImpl, calls, inits } = deleteFetch(204);
    await cancelJob("job-7", { baseURL: "http://localhost:8002/", fetchImpl });
    expect(calls).toEqual(["http://localhost:8002/jobs/job-7"]);
    expect(inits[0]?.method).toBe("DELETE");
  });

  it("treats 404 as already-gone (no throw) — cancelling twice is not an error", async () => {
    const { fetchImpl, calls } = deleteFetch(404, { detail: "no such job" });
    await expect(cancelJob("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toEqual(["http://localhost:8002/jobs/gone"]); // default base URL
  });

  it("surfaces other HTTP errors with the server detail, like the train helpers", async () => {
    const { fetchImpl } = deleteFetch(401, { detail: "missing or invalid API key" });
    await expect(cancelJob("job-7", { fetchImpl })).rejects.toThrow(
      /nerf cancel: HTTP 401 — missing or invalid API key/,
    );
  });

  it("sends Authorization: Bearer <key> when apiKey is set, and no header otherwise", async () => {
    const withKey = deleteFetch(204);
    await cancelJob("job-7", { fetchImpl: withKey.fetchImpl, apiKey: "nerf-secret" });
    expect(authOf(withKey.inits[0])).toBe("Bearer nerf-secret");

    const withoutKey = deleteFetch(204);
    await cancelJob("job-7", { fetchImpl: withoutKey.fetchImpl });
    expect(authOf(withoutKey.inits[0])).toBeUndefined();
  });
});
