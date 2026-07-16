import { describe, expect, it } from "vitest";
import { cancelJob, reconstructMesh } from "./index.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Authorization header of a recorded request (plain-object headers). */
function authOf(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.["Authorization"];
}

describe("reconstructMesh", () => {
  it("submits, polls, and returns STEP + report", async () => {
    let statusHits = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "j1", state: "queued" });
      if (url.endsWith("/status")) {
        statusHits += 1;
        return jsonResponse({
          id: "j1",
          state: statusHits > 1 ? "completed" : "running",
        });
      }
      if (url.endsWith("/result"))
        return jsonResponse({
          step: "ISO-10303-21;",
          report: {
            triangles_in: 10,
            triangles_used: 10,
            faces_built: 6,
            planar_faces: 6,
            is_solid: true,
            is_valid: true,
            method: "faceted",
          },
        });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const res = await reconstructMesh("Z2xURg==", {
      baseURL: "http://localhost:8000/",
      fetchImpl,
      delay: async () => {},
    });
    expect(res.step).toContain("ISO");
    expect(res.report.is_solid).toBe(true);
    expect(res.report.faces_built).toBe(6);
  });

  it("exposes the submitted job id via onJob before polling (the cancelJob handle)", async () => {
    const calls: string[] = [];
    let statusHits = 0;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "job-1", state: "queued" });
      if (url.endsWith("/status")) {
        statusHits += 1;
        return jsonResponse({ id: "job-1", state: statusHits > 0 ? "completed" : "running" });
      }
      if (url.endsWith("/result"))
        return jsonResponse({
          step: "ISO-10303-21;",
          report: {
            triangles_in: 1,
            triangles_used: 1,
            faces_built: 1,
            planar_faces: 1,
            is_solid: true,
            is_valid: true,
            method: "faceted",
          },
        });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const ids: string[] = [];
    await reconstructMesh("x", { fetchImpl, delay: async () => {}, onJob: (id) => ids.push(id) });
    expect(ids).toEqual(["job-1"]);
    expect(calls[1]).toBe("http://localhost:8000/jobs/job-1/status");
  });

  it("throws on failed job", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/reconstruct")) return jsonResponse({ id: "j", state: "queued" });
      if (url.endsWith("/status"))
        return jsonResponse({ id: "j", state: "failed", error: "occt crashed" });
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    await expect(reconstructMesh("x", { fetchImpl, delay: async () => {} })).rejects.toThrow(
      /reconstruction failed: occt crashed/,
    );
  });
});

/** Single-shot fetch answering DELETE with `status`, recording the request. */
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

describe("cancelJob (DELETE /jobs/{id})", () => {
  it("issues DELETE {base}/jobs/{id} (base normalized) and resolves on 204", async () => {
    const { fetchImpl, calls, inits } = deleteFetch(204);
    await cancelJob("job-1", { baseURL: "http://localhost:8000/", fetchImpl });
    expect(calls).toEqual(["http://localhost:8000/jobs/job-1"]);
    expect(inits[0]?.method).toBe("DELETE");
  });

  it("treats 404 as already-gone (no throw) — cancelling twice is not an error", async () => {
    const { fetchImpl, calls } = deleteFetch(404, { detail: "no such job" });
    await expect(cancelJob("gone", { fetchImpl })).resolves.toBeUndefined();
    expect(calls).toEqual(["http://localhost:8000/jobs/gone"]);
  });

  it("surfaces other HTTP errors with the server detail", async () => {
    const { fetchImpl } = deleteFetch(401, { detail: "missing or invalid API key" });
    await expect(cancelJob("job-1", { fetchImpl })).rejects.toThrow(
      /reconstruct cancel: HTTP 401 — missing or invalid API key/,
    );
  });

  it("sends Authorization: Bearer <key> when apiKey is set, and no header otherwise", async () => {
    const withKey = deleteFetch(204);
    await cancelJob("job-1", { fetchImpl: withKey.fetchImpl, apiKey: "recon-secret" });
    expect(authOf(withKey.inits[0])).toBe("Bearer recon-secret");

    const withoutKey = deleteFetch(204);
    await cancelJob("job-1", { fetchImpl: withoutKey.fetchImpl });
    expect(authOf(withoutKey.inits[0])).toBeUndefined();
  });
});
