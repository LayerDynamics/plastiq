import { describe, expect, it } from "vitest";
import { cancelServiceJob, serviceHttpError } from "./http.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("serviceHttpError", () => {
  it("formats status + FastAPI detail", async () => {
    const msg = await serviceHttpError(jsonResponse(401, { detail: "missing key" }), "reconstruct", "cancel");
    expect(msg).toBe("reconstruct cancel: HTTP 401 — missing key");
  });

  it("omits detail when the body is empty or non-JSON", async () => {
    const bare = {
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response;
    expect(await serviceHttpError(bare, "nerf", "submit")).toBe("nerf submit: HTTP 500");
  });
});

describe("cancelServiceJob", () => {
  it("DELETE {base}/jobs/{id}, normalizes trailing slash, resolves on 204", async () => {
    const calls: string[] = [];
    const methods: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      methods.push(init?.method ?? "GET");
      return jsonResponse(204, {});
    }) as unknown as typeof fetch;

    await cancelServiceJob("job-1", {
      baseURL: "http://localhost:8000/",
      fetchImpl,
      defaultBaseURL: "http://localhost:8000",
      label: "reconstruct",
    });
    expect(calls).toEqual(["http://localhost:8000/jobs/job-1"]);
    expect(methods).toEqual(["DELETE"]);
  });

  it("uses defaultBaseURL when baseURL is omitted", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return jsonResponse(204, {});
    }) as unknown as typeof fetch;

    await cancelServiceJob("j", {
      fetchImpl,
      defaultBaseURL: "http://localhost:8001",
      label: "capture",
    });
    expect(calls).toEqual(["http://localhost:8001/jobs/j"]);
  });

  it("treats 404 as already-gone", async () => {
    const fetchImpl = (async () => jsonResponse(404, { detail: "gone" })) as unknown as typeof fetch;
    await expect(
      cancelServiceJob("gone", { fetchImpl, defaultBaseURL: "http://localhost:8000", label: "nurbs" }),
    ).resolves.toBeUndefined();
  });

  it("throws other HTTP errors with label + detail", async () => {
    const fetchImpl = (async () =>
      jsonResponse(401, { detail: "missing or invalid API key" })) as unknown as typeof fetch;
    await expect(
      cancelServiceJob("job-1", { fetchImpl, defaultBaseURL: "http://localhost:8000", label: "reconstruct" }),
    ).rejects.toThrow(/reconstruct cancel: HTTP 401 — missing or invalid API key/);
  });

  it("sends Authorization only when apiKey is set", async () => {
    const withKeyInits: RequestInit[] = [];
    const withKey = (async (_u: string, init?: RequestInit) => {
      withKeyInits.push(init ?? {});
      return jsonResponse(204, {});
    }) as unknown as typeof fetch;
    await cancelServiceJob("job-1", {
      fetchImpl: withKey,
      apiKey: "secret",
      defaultBaseURL: "http://localhost:8002",
      label: "nerf",
    });
    expect((withKeyInits[0]?.headers as Record<string, string>)?.Authorization).toBe("Bearer secret");

    const bareInits: RequestInit[] = [];
    const bare = (async (_u: string, init?: RequestInit) => {
      bareInits.push(init ?? {});
      return jsonResponse(204, {});
    }) as unknown as typeof fetch;
    await cancelServiceJob("job-1", {
      fetchImpl: bare,
      defaultBaseURL: "http://localhost:8002",
      label: "nerf",
    });
    expect(bareInits[0]?.headers).toBeUndefined();
  });
});
