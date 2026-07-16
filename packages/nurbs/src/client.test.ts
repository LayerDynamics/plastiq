// @plastiq/nurbs — fitNurbs: submit → poll → result over a scripted fake fetch (no network).
// Mirrors the capture/reconstruct/nerf service contract: POST /fit → GET /jobs/{id}/status until
// "completed" → GET /jobs/{id}/result. (SPEC-12 §6.1, U9.2.)

import { describe, expect, it } from "vitest";
import { cancelJob, fitNurbs } from "./client.js";

/** A §6.2 surface exactly as the service serializes it — snake_case, compact knots. The client
 * must pass this through VERBATIM (untranslated), so the fixture doubles as the contract check. */
const SURFACE_WIRE = {
  poles: [
    [
      [0, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0.5],
    ],
  ],
  weights: [] as number[][],
  u_knots: [0, 1],
  v_knots: [0, 1],
  u_mults: [2, 2],
  v_mults: [2, 2],
  u_degree: 1,
  v_degree: 1,
  u_periodic: false,
  v_periodic: false,
};

const RESULT_WIRE = {
  step: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;",
  surfaces: [SURFACE_WIRE],
  report: {
    patches: 6,
    fitted_patches: 5,
    faceted_patches: 1,
    control_points: 256,
    degree_u: 3,
    degree_v: 3,
    iters: 200,
    chamfer: 0.00042,
    scd: 0.0011,
    rms_deviation: 0.0003,
    max_deviation: 0.0018,
    fidelity_tol: 0.002,
    is_solid: true,
    is_valid: true,
    mode: "closed",
  },
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
    if (url.endsWith("/fit")) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "job-12", state: "queued" });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "job-12", state: statusHits > running ? "completed" : "running" });
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

describe("fitNurbs (SPEC-12 §6.1, U9.2)", () => {
  it("submits, polls until completed, and maps the wire result to { step, surfaces, report }", async () => {
    const { fetchImpl, calls } = scriptedFetch({ runningPolls: 2 });
    const states: string[] = [];
    const res = await fitNurbs(
      { glbBase64: "Z2xURg==" },
      { baseURL: "http://localhost:8003/", fetchImpl, delay: async () => {}, onState: (s) => states.push(s) },
    );
    expect(res.step).toBe(RESULT_WIRE.step);
    // surfaces pass through VERBATIM — the §6.2 snake_case serialization, untranslated
    expect(res.surfaces).toEqual([SURFACE_WIRE]);
    expect(res.surfaces[0]?.u_knots).toEqual([0, 1]);
    expect(res.surfaces[0]?.u_periodic).toBe(false);
    // report is mapped snake_case → camelCase (FR-9)
    expect(res.report.patches).toBe(6);
    expect(res.report.fittedPatches).toBe(5);
    expect(res.report.facetedPatches).toBe(1);
    expect(res.report.controlPoints).toBe(256);
    expect(res.report.degreeU).toBe(3);
    expect(res.report.degreeV).toBe(3);
    expect(res.report.iters).toBe(200);
    expect(res.report.chamfer).toBeCloseTo(0.00042);
    expect(res.report.scd).toBeCloseTo(0.0011);
    expect(res.report.rmsDeviation).toBeCloseTo(0.0003);
    expect(res.report.maxDeviation).toBeCloseTo(0.0018);
    expect(res.report.fidelityTol).toBeCloseTo(0.002);
    expect(res.report.isSolid).toBe(true);
    expect(res.report.isValid).toBe(true);
    expect(res.report.mode).toBe("closed");
    expect(states).toContain("running");
    expect(states).toContain("completed");
    // trailing slash on the base URL is normalized (no //fit)
    expect(calls[0]).toBe("http://localhost:8003/fit");
  });

  it("forwards glb_base64 + options on the submit body (snake_case wire form)", async () => {
    const { fetchImpl, calls, submitBody } = scriptedFetch();
    await fitNurbs(
      { glbBase64: "bWVzaA==", mode: "closed", degree: 4, grid: 24, iters: 500, fidelityTol: 0.001 },
      { fetchImpl, delay: async () => {} },
    );
    // no baseURL given ⇒ the documented dev default (:8003)
    expect(calls[0]).toBe("http://localhost:8003/fit");
    const body = submitBody();
    expect(body).toBeDefined();
    expect(body!.glb_base64).toBe("bWVzaA==");
    expect(body!.mode).toBe("closed");
    expect(body!.degree).toBe(4);
    expect(body!.grid).toBe(24);
    expect(body!.iters).toBe(500);
    expect(body!.fidelity_tol).toBe(0.001);
  });

  it("omits unset optional fields from the submit body (service defaults apply)", async () => {
    const { fetchImpl, submitBody } = scriptedFetch();
    await fitNurbs({ glbBase64: "bWVzaA==" }, { fetchImpl, delay: async () => {} });
    const body = submitBody();
    expect(body).toBeDefined();
    expect(body!.glb_base64).toBe("bWVzaA==");
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("degree");
    expect(body).not.toHaveProperty("grid");
    expect(body).not.toHaveProperty("iters");
    expect(body).not.toHaveProperty("fidelity_tol");
  });

  it("throws with the backend detail on a failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/fit")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status"))
        return jsonResponse({ id: "j", state: "failed", error: "genus >= 1 input rejected" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(
      fitNurbs({ glbBase64: "" }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/nurbs fit failed: genus >= 1 input rejected/);
  });

  it("surfaces an HTTP error (with detail) from submit", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ detail: "glb_base64 is not valid base64" }, false, 400)) as unknown as typeof fetch;
    await expect(
      fitNurbs({ glbBase64: "!!" }, { fetchImpl, delay: async () => {} }),
    ).rejects.toThrow(/nurbs submit: HTTP 400.*not valid base64/);
  });

  it("exposes the submitted job id via onJob before polling (the cancelJob handle)", async () => {
    const { fetchImpl, calls } = scriptedFetch();
    const ids: string[] = [];
    await fitNurbs({ glbBase64: "" }, { fetchImpl, delay: async () => {}, onJob: (id) => ids.push(id) });
    // Fired exactly once, with the id the /jobs/{id}/… polls then use — so a caller holding it
    // mid-fit can DELETE the same job the service is running.
    expect(ids).toEqual(["job-12"]);
    expect(calls[1]).toBe("http://localhost:8003/jobs/job-12/status");
  });

  it("times out after maxPolls when the job never completes", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/fit")) return jsonResponse({ id: "j", state: "queued" });
      return jsonResponse({ id: "j", state: "running" });
    }) as unknown as typeof fetch;
    await expect(
      fitNurbs({ glbBase64: "" }, { fetchImpl, delay: async () => {}, maxPolls: 3 }),
    ).rejects.toThrow(/timed out after 3 polls/);
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

describe("cancelJob (SPEC-12 §6.1 — DELETE /jobs/{id})", () => {
  it("issues DELETE {base}/jobs/{id} (base normalized) and resolves on 204", async () => {
    const { fetchImpl, calls, inits } = deleteFetch(204);
    await cancelJob("job-12", { baseURL: "http://localhost:8003/", fetchImpl });
    expect(calls).toEqual(["http://localhost:8003/jobs/job-12"]);
    expect(inits[0]?.method).toBe("DELETE");
  });

  it("treats 404 as already-gone (no throw) — cancelling twice is not an error", async () => {
    const { fetchImpl, calls } = deleteFetch(404, { detail: "no such job" });
    await expect(cancelJob("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toEqual(["http://localhost:8003/jobs/gone"]); // default base URL
  });

  it("surfaces other HTTP errors with the server detail, like the fit helpers", async () => {
    const { fetchImpl } = deleteFetch(401, { detail: "missing or invalid API key" });
    await expect(cancelJob("job-12", { fetchImpl })).rejects.toThrow(
      /nurbs cancel: HTTP 401 — missing or invalid API key/,
    );
  });

  it("sends Authorization: Bearer <key> when apiKey is set, and no header otherwise", async () => {
    const withKey = deleteFetch(204);
    await cancelJob("job-12", { fetchImpl: withKey.fetchImpl, apiKey: "nurbs-secret" });
    expect(authOf(withKey.inits[0])).toBe("Bearer nurbs-secret");

    const withoutKey = deleteFetch(204);
    await cancelJob("job-12", { fetchImpl: withoutKey.fetchImpl });
    expect(authOf(withoutKey.inits[0])).toBeUndefined();
  });
});

describe("fitNurbs auth header (SPEC-12 §6.1 — NURBS_API_KEY deployments)", () => {
  it("sends Authorization: Bearer <key> on EVERY request when apiKey is set", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch({ runningPolls: 2 });
    await fitNurbs({ glbBase64: "" }, { fetchImpl, delay: async () => {}, apiKey: "nurbs-secret" });
    // submit + status(running)×2 + status(completed) + result — the header rides on all of them
    expect(calls).toHaveLength(5);
    for (const init of inits) expect(authOf(init)).toBe("Bearer nurbs-secret");
    // …and the submit request keeps its JSON content type alongside the auth header
    expect((inits[0]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends NO Authorization header when apiKey is absent (the open dev default)", async () => {
    const { fetchImpl, calls, inits } = scriptedFetch();
    await fitNurbs({ glbBase64: "" }, { fetchImpl, delay: async () => {} });
    expect(calls.length).toBeGreaterThan(0);
    for (const init of inits) expect(authOf(init)).toBeUndefined();
  });
});
