// SPEC-13 P11.2 — the app-side photogrammetry adapter: solvePhotogrammetry/cancelPhotogrammetry
// resolve the service base URL + API key from the persisted settings (photogrammetryBaseURL/
// photogrammetryApiKey, the SPEC-11 §5 auth model), calling @plastiq/photogrammetry's solvePhotos/
// cancelJob (mocked here — the client's own HTTP contract is tested in packages/photogrammetry);
// parseDenseCloud/denseCloudToMeshDoc parse the dense PLY and reconstruct it via the REAL capture
// path (@plastiq/capture, driven over a scripted fetch — no server).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelJob, solvePhotos } from "@plastiq/photogrammetry";
import {
  cancelPhotogrammetry,
  denseCloudToMeshDoc,
  denseCloudToPointCloudDoc,
  parseDenseCloud,
  solvePhotogrammetry,
} from "./photogrammetry.js";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";
import type { MeshDoc } from "../store/types.js";

vi.mock("@plastiq/photogrammetry", () => ({ solvePhotos: vi.fn(), cancelJob: vi.fn() }));
const solvePhotosMock = vi.mocked(solvePhotos);
const cancelJobMock = vi.mocked(cancelJob);

const BASE_SETTINGS: AiSettings = { providerKey: "anthropic", providerId: "anthropic", model: "m", apiKeys: {} };

const SOLVE_INPUT = { images: ["a", "b", "c"] };

/** A dense oriented ASCII PLY (`x y z nx ny nz r g b`), base64-encoded as the service returns it. */
function densePlyB64(): string {
  const text = [
    "ply",
    "format ascii 1.0",
    "element vertex 2",
    "property float x",
    "property float y",
    "property float z",
    "property float nx",
    "property float ny",
    "property float nz",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
    "0 0 0 0 0 1 100 100 100",
    "1 1 1 0 1 0 200 200 200",
    "",
  ].join("\n");
  return btoa(text);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** submit → status(running) → status(completed) → result for the capture service (/capture). */
function captureScriptedFetch(result: unknown): { fetchImpl: typeof fetch; calls: string[]; body: () => Record<string, unknown> | undefined } {
  const calls: string[] = [];
  let body: Record<string, unknown> | undefined;
  let statusHits = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith("/capture")) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return jsonResponse({ id: "cap-1", state: "queued" });
    }
    if (url.endsWith("/status")) {
      statusHits += 1;
      return jsonResponse({ id: "cap-1", state: statusHits > 1 ? "completed" : "running" });
    }
    if (url.endsWith("/result")) return jsonResponse(result);
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, body: () => body };
}

beforeEach(() => {
  useAiStore.setState({ settings: null, loaded: false });
  solvePhotosMock.mockReset();
  cancelJobMock.mockReset();
  solvePhotosMock.mockResolvedValue({} as never);
  cancelJobMock.mockResolvedValue(undefined as never);
});

describe("solvePhotogrammetry — settings resolution (photogrammetryBaseURL/ApiKey, SPEC-13 §6.1)", () => {
  it("threads the persisted base URL + key; absent ⇒ neither (client default)", async () => {
    await solvePhotogrammetry(SOLVE_INPUT);
    expect(solvePhotosMock.mock.calls[0]![1]?.baseURL).toBeUndefined();
    expect(solvePhotosMock.mock.calls[0]![1]?.apiKey).toBeUndefined();

    useAiStore.setState({
      settings: { ...BASE_SETTINGS, photogrammetryBaseURL: "https://pg.example", photogrammetryApiKey: "pg-secret" },
      loaded: true,
    });
    await solvePhotogrammetry(SOLVE_INPUT);
    expect(solvePhotosMock.mock.calls[1]![1]?.baseURL).toBe("https://pg.example");
    expect(solvePhotosMock.mock.calls[1]![1]?.apiKey).toBe("pg-secret");
  });

  it("a caller-supplied opts.baseURL/apiKey wins over the persisted settings, and passes the input + other opts", async () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, photogrammetryBaseURL: "https://from-settings", photogrammetryApiKey: "from-settings" },
      loaded: true,
    });
    const onJob = (): void => {};
    await solvePhotogrammetry(SOLVE_INPUT, { baseURL: "https://explicit", apiKey: "explicit-key", onJob });
    const opts = solvePhotosMock.mock.calls[0]![1]!;
    expect(opts.baseURL).toBe("https://explicit");
    expect(opts.apiKey).toBe("explicit-key");
    expect(opts.onJob).toBe(onJob);
    expect(solvePhotosMock.mock.calls[0]![0]).toBe(SOLVE_INPUT);
  });
});

describe("cancelPhotogrammetry", () => {
  it("threads settings and DELETEs the job", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, photogrammetryApiKey: "pg-secret" }, loaded: true });
    await cancelPhotogrammetry("job-9");
    expect(cancelJobMock).toHaveBeenCalledTimes(1);
    expect(cancelJobMock.mock.calls[0]![0]).toBe("job-9");
    expect(cancelJobMock.mock.calls[0]![1]?.apiKey).toBe("pg-secret");
  });
});

describe("parseDenseCloud", () => {
  it("decodes the base64 dense PLY into the capture service's {points, normals}", () => {
    const input = parseDenseCloud(densePlyB64());
    expect(input.points).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]);
    expect(input.normals).toEqual([
      [0, 0, 1],
      [0, 1, 0],
    ]);
  });

  it("throws when the cloud carries no normals (a /capture requirement)", () => {
    const noNormals = btoa(
      ["ply", "format ascii 1.0", "element vertex 1", "property float x", "property float y", "property float z", "end_header", "0 0 0", ""].join("\n"),
    );
    expect(() => parseDenseCloud(noNormals)).toThrow(/no normals/);
  });
});

describe("denseCloudToPointCloudDoc — the on-canvas cloud (SPEC-13), colour-preserving", () => {
  it("flattens points + colours + normals into a PointCloudDoc (colours normalized 0..1)", () => {
    const doc = denseCloudToPointCloudDoc(densePlyB64(), "My scan");
    expect(doc.kind).toBe("pointcloud");
    expect(doc.name).toBe("My scan");
    expect(doc.source).toEqual({ mode: "photos3d", providerId: "photogrammetry" });
    expect(doc.points).toEqual([0, 0, 0, 1, 1, 1]); // flat, from the two vertices
    expect(doc.normals).toEqual([0, 0, 1, 0, 1, 0]);
    // uchar 100/200 → 100/255, 200/255 (the parser's 0..1 conversion), then flattened
    expect(doc.colors![0]).toBeCloseTo(100 / 255);
    expect(doc.colors![3]).toBeCloseTo(200 / 255);
    expect(doc.colors).toHaveLength(6);
  });
});

describe("denseCloudToMeshDoc — hand-off (b): dense cloud → mesh via the capture service", () => {
  it("parses the PLY, POSTs {points, normals} to /capture, and persists a MeshDoc", async () => {
    let persisted: MeshDoc | null = null;
    const { fetchImpl, calls, body } = captureScriptedFetch({ glb_base64: "R0xCbWVzaA==", vertices: 500, faces: 900 });

    const res = await denseCloudToMeshDoc(
      densePlyB64(),
      {
        persist: async (d) => {
          persisted = d;
          return "mesh-pg";
        },
      },
      { fetchImpl, delay: async () => {}, baseURL: "http://cap.local:8001" },
      "Photogrammetry mesh",
    );

    expect(res.meshDocId).toBe("mesh-pg");
    expect(res.doc.glb).toBe("R0xCbWVzaA==");
    expect(res.doc.name).toBe("Photogrammetry mesh");
    expect((persisted as unknown as MeshDoc).source.mode).toBe("photos3d");
    // The parsed dense points/normals rode the /capture body.
    expect(calls[0]).toBe("http://cap.local:8001/capture");
    const b = body();
    expect(b?.points).toEqual([
      [0, 0, 0],
      [1, 1, 1],
    ]);
    expect(b?.normals).toEqual([
      [0, 0, 1],
      [0, 1, 0],
    ]);
  });
});
