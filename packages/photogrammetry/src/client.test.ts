// @plastiq/photogrammetry — solvePhotos: submit → poll → result over a scripted fake fetch (no
// network). Mirrors the capture/nerf/reconstruct service contract: POST /solve → GET
// /jobs/{id}/status until "completed" → GET /jobs/{id}/result (SPEC-13 §6.1). Plus the cross-package
// dense-cloud → @plastiq/capture PLY hand-off contract (the P6.3 fixture parsed by the real parser).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePointCloud } from "@plastiq/capture";
import { cancelJob, solvePhotos } from "./client.js";

/** A minimal but complete FR-8 report, snake_case as it rides the wire. */
const REPORT_WIRE = {
  images_total: 8,
  images_registered: 8,
  unregistered_names: [] as string[],
  sparse_points: 640,
  dense_points: 51200,
  mean_reprojection_error_px: 0.83,
  mean_track_length: 4.2,
  camera: { model: "OPENCV", w: 1920, h: 1080, fl_x: 1657.2, fl_y: 1657.2, cx: 960, cy: 540, k1: 0, k2: 0, p1: 0, p2: 0 },
  normalization: { applied_transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], scale: 0.5 },
  matching: "exhaustive",
  seed: 0,
  dense: true,
};

const RESULT_WIRE = {
  transforms_json: '{"w":1920,"h":1080,"frames":[]}',
  sparse_ply_base64: "c3BhcnNl",
  dense_ply_base64: "ZGVuc2U=",
  report: REPORT_WIRE,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** A fetch that walks submit → status(running)×N → status(completed) → result, recording every URL
 * + its RequestInit and the parsed submit body so tests can assert the wire contract (paths,
 * snake_case body, and per-request headers). */
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
    if (url.endsWith("/solve")) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "job-9", state: "queued", error: null });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-9", state: statusHits > running ? "completed" : "running" });
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

describe("solvePhotos (SPEC-13 §6.1)", () => {
  it("submits to /solve, polls until completed, and maps the wire result snake→camel", async () => {
    const { fetchImpl, calls } = scriptedFetch({ runningPolls: 2 });
    const states: string[] = [];
    const res = await solvePhotos(
      { images: ["aW1n"] },
      { baseURL: "http://localhost:8004/", fetchImpl, delay: async () => {}, onState: (s) => states.push(s) },
    );
    expect(res.transformsJson).toBe('{"w":1920,"h":1080,"frames":[]}');
    expect(res.sparsePly).toBe("c3BhcnNl");
    expect(res.densePly).toBe("ZGVuc2U=");
    expect(res.report.images_registered).toBe(8);
    expect(res.report.camera.fl_x).toBeCloseTo(1657.2);
    expect(res.report.normalization.scale).toBeCloseTo(0.5);
    // onState fires with the real job state on every poll (M4 — the panel shows real progress)
    expect(states).toContain("running");
    expect(states).toContain("completed");
    // trailing slash on the base URL is normalized (no //solve)
    expect(calls[0]).toBe("http://localhost:8004/solve");
    expect(calls[1]).toBe("http://localhost:8004/jobs/job-9/status");
  });

  it("carries a null dense_ply through as null (dense:false or fusion empty)", async () => {
    const { fetchImpl } = scriptedFetch({
      result: { ...RESULT_WIRE, dense_ply_base64: null },
    });
    const res = await solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {} });
    expect(res.densePly).toBeNull();
    expect(res.sparsePly).toBe("c3BhcnNl"); // sparse always present
  });

  it("forwards names/matching/dense/maxFeatures/seed as snake_case, omitting unset knobs", async () => {
    const withKnobs = scriptedFetch();
    await solvePhotos(
      { images: ["a", "b"], names: ["a.jpg", "b.jpg"], matching: "sequential", dense: false, maxFeatures: 8192, seed: 7 },
      { fetchImpl: withKnobs.fetchImpl, delay: async () => {} },
    );
    const body = withKnobs.submitBody();
    expect(body).toBeDefined();
    expect(body!.images).toEqual(["a", "b"]);
    expect(body!.names).toEqual(["a.jpg", "b.jpg"]);
    expect(body!.matching).toBe("sequential");
    expect(body!.dense).toBe(false);
    expect(body!.max_features).toBe(8192);
    expect(body!.seed).toBe(7);

    // T39: sparseMaxDim → sparse_max_dim on the wire
    const withRes = scriptedFetch();
    await solvePhotos(
      { images: ["a", "b", "c"], sparseMaxDim: 640 },
      { fetchImpl: withRes.fetchImpl, delay: async () => {} },
    );
    expect(withRes.submitBody()!.sparse_max_dim).toBe(640);

    // Unset → absent entirely (the service's own defaults apply; nothing sent speculatively).
    const bare = scriptedFetch();
    await solvePhotos({ images: ["x"] }, { fetchImpl: bare.fetchImpl, delay: async () => {} });
    const bareBody = bare.submitBody()!;
    for (const k of ["names", "matching", "dense", "max_features", "seed", "sparse_max_dim"]) {
      expect(k in bareBody).toBe(false);
    }
    expect(bareBody.images).toEqual(["x"]);
  });

  it("exposes the submitted job id via onJob before polling (the cancelJob handle)", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const ids: string[] = [];
    await solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {}, onJob: (id) => ids.push(id) });
    expect(ids).toEqual(["job-9"]);
    expect(calls[1]).toBe("http://localhost:8004/jobs/job-9/status");
  });

  it("throws with the backend detail on a failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/solve")) return jsonResponse({ id: "j", state: "queued", error: null });
      if (url.endsWith("/status")) return jsonResponse({ id: "j", state: "failed", error: "init pair degenerate: too few inliers" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(
      solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/photogrammetry solve failed: init pair degenerate/);
  });

  it("surfaces an HTTP error (with detail) from submit — e.g. a 429 over the concurrency cap", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ detail: "a solve is already running (PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS=1)" }, false, 429)) as unknown as typeof fetch;
    await expect(
      solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/photogrammetry submit: HTTP 429 — a solve is already running/);
  });

  it("times out after maxPolls when the job never completes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/solve")) return jsonResponse({ id: "j", state: "queued", error: null });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {}, maxPolls: 3 }),
    ).rejects.toThrow(/timed out after 3 polls/);
  });
});

describe("solvePhotos auth header (SPEC-13 FR-10 — PHOTOGRAMMETRY_API_KEY deployments)", () => {
  it("sends Authorization: Bearer <key> on EVERY request when apiKey is set", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch({ runningPolls: 2 });
    await solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {}, apiKey: "photo-secret" });
    // submit + status(running)×2 + status(completed) + result — the header rides on all of them
    expect(calls).toHaveLength(5);
    for (const init of inits) expect(authOf(init)).toBe("Bearer photo-secret");
    // …and the submit request keeps its JSON content type alongside the auth header
    expect((inits[0]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends NO Authorization header when apiKey is absent (the open dev default)", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch();
    await solvePhotos({ images: ["aW1n"] }, { fetchImpl, delay: async () => {} });
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

describe("cancelJob (SPEC-13 §6.1 — DELETE /jobs/{id})", () => {
  it("issues DELETE {base}/jobs/{id} (base normalized) and resolves on 204", async () => {
    const { fetchImpl, calls, inits } = deleteFetch(204);
    await cancelJob("job-9", { baseURL: "http://localhost:8004/", fetchImpl });
    expect(calls).toEqual(["http://localhost:8004/jobs/job-9"]);
    expect(inits[0]?.method).toBe("DELETE");
  });

  it("treats 404 as already-gone (no throw) — cancelling twice is not an error", async () => {
    const { fetchImpl, calls } = deleteFetch(404, { detail: "no such job" });
    await expect(cancelJob("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toEqual(["http://localhost:8004/jobs/gone"]); // default base URL
  });

  it("surfaces other HTTP errors with the server detail, like the solve helper", async () => {
    const { fetchImpl } = deleteFetch(401, { detail: "missing or invalid API key" });
    await expect(cancelJob("job-9", { fetchImpl })).rejects.toThrow(
      /photogrammetry cancel: HTTP 401 — missing or invalid API key/,
    );
  });

  it("sends Authorization: Bearer <key> when apiKey is set, and no header otherwise", async () => {
    const withKey = deleteFetch(204);
    await cancelJob("job-9", { fetchImpl: withKey.fetchImpl, apiKey: "photo-secret" });
    expect(authOf(withKey.inits[0])).toBe("Bearer photo-secret");

    const withoutKey = deleteFetch(204);
    await cancelJob("job-9", { fetchImpl: withoutKey.fetchImpl });
    expect(authOf(withoutKey.inits[0])).toBeUndefined();
  });
});

describe("dense-cloud → @plastiq/capture hand-off (SPEC-13 FR-5 / §6.3)", () => {
  it("parses the emitted dense PLY fixture with the REAL capture parser into Nx3 points + normals", () => {
    // The P6.3 emitter commits this ASCII PLY (x y z nx ny nz red green blue) so the capture leg
    // needs zero new parsing — this asserts that exact cross-package contract with the real parser.
    const plyPath = fileURLToPath(
      new URL("../../../services/photogrammetry/tests/fixtures/dense_sample.ply", import.meta.url),
    );
    const cloud = parsePointCloud("dense_sample.ply", readFileSync(plyPath, "utf8"));
    expect(cloud.points).toHaveLength(8);
    expect(cloud.normals).toBeDefined();
    expect(cloud.normals).toHaveLength(8);
    // First and last cube corners + their outward diagonal unit normals round-trip through the parser.
    expect(cloud.points[0]).toEqual([0, 0, 0]);
    expect(cloud.points[7]).toEqual([1, 1, 1]);
    const inv3 = 0.577350269;
    expect(cloud.normals![0]).toEqual([-inv3, -inv3, -inv3]);
    expect(cloud.normals![7]).toEqual([inv3, inv3, inv3]);
    // Every parsed value is finite (the parser's strictness contract) and unit-length normals.
    for (const [nx, ny, nz] of cloud.normals!) {
      expect(Math.hypot(nx!, ny!, nz!)).toBeCloseTo(1, 6);
    }
  });
});
