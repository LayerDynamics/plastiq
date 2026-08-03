// @vitest-environment jsdom
//
// SPEC-13 P11.2 — the PhotoSolveSection: unposed photos → poses + dense cloud → CAD, driven through
// the panel with a REAL file input (FileReader) and a REAL /health pre-check (scripted global fetch),
// but with the photogrammetry + nerf ADAPTERS mocked (their own HTTP contracts are covered in
// photogrammetry.unit.test.ts / packages). Covers: the health pre-check gate; the happy solve →
// result buttons; both success hand-offs — (a) Poses → NeRF (captureFromPhotos) and (b) dense cloud →
// mesh (denseCloudToMeshDoc), each persisting + opening a MeshDoc (→ Convert-to-CAD); and Cancel
// (aborts the poll + DELETEs the server job).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import {
  cancelPhotogrammetry,
  denseCloudToMeshDoc,
  solvePhotogrammetry,
} from "./photogrammetry.js";
import { captureFromPhotos } from "./nerf.js";
import type { MeshDoc } from "../store/types.js";

vi.mock("./photogrammetry.js", () => ({
  solvePhotogrammetry: vi.fn(),
  cancelPhotogrammetry: vi.fn(async () => {}),
  denseCloudToMeshDoc: vi.fn(),
  DEFAULT_SPARSE_MAX_DIM: 1600,
}));
vi.mock("./nerf.js", () => ({
  captureFromPhotos: vi.fn(),
  cancelCapture: vi.fn(async () => {}),
}));

const solveMock = vi.mocked(solvePhotogrammetry);
const cancelMock = vi.mocked(cancelPhotogrammetry);
const denseToMeshMock = vi.mocked(denseCloudToMeshDoc);
const captureFromPhotosMock = vi.mocked(captureFromPhotos);

const realFetch = globalThis.fetch;

/** A canned successful solve result — poses + a dense cloud + a registration report. */
function solveResult(overrides: Record<string, unknown> = {}) {
  return {
    transformsJson:
      '{"frames":[{"file_path":"./images/a.jpg"},{"file_path":"./images/b.jpg"},{"file_path":"./images/c.jpg"}]}',
    sparsePly: "cGx5",
    densePly: "ZGVuc2VwbHk=",
    report: {
      images_total: 3,
      images_registered: 3,
      unregistered_names: [],
      sparse_points: 120,
      dense_points: 5000,
      mean_reprojection_error_px: 0.7,
      mean_track_length: 4.2,
      matching: "exhaustive",
      seed: 0,
      dense: true,
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  // Every /health probe answers ok (the adapters themselves are mocked, so no other fetch fires).
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith("/health")) return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as unknown as typeof fetch;
  solveMock.mockReset();
  cancelMock.mockReset().mockResolvedValue(undefined as never);
  denseToMeshMock.mockReset();
  captureFromPhotosMock.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Replace the two projectsStore actions the section drives, recording their inputs. */
function stubProjectsStore(): { persisted: () => MeshDoc | null; opened: () => string | null } {
  let doc: MeshDoc | null = null;
  let openedId: string | null = null;
  useProjectsStore.setState({
    createMeshProject: async (d: MeshDoc) => {
      doc = d;
      return "mesh-42";
    },
    open: async (id: string) => {
      openedId = id;
    },
  });
  return { persisted: () => doc, opened: () => openedId };
}

/** Pick N photos through the section's real multi-file input. */
async function pickPhotos(n: number): Promise<void> {
  const files = Array.from({ length: n }, (_, i) => new File([`img${i}`], `${String.fromCharCode(97 + i)}.jpg`, { type: "image/jpeg" }));
  await act(async () => {
    fireEvent.change(screen.getByTestId("photo-images-input"), { target: { files } });
  });
  await waitFor(() => expect((screen.getByTestId("photo-solve-btn") as HTMLButtonElement).disabled).toBe(false));
}

describe("PhotoSolveSection — solve + hand-offs (SPEC-13 P11.2)", () => {
  it("an unreachable service shows the start hint and never submits", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("photo-error").textContent).toMatch(/unreachable/));
    expect(solveMock).not.toHaveBeenCalled();
  });

  it("solves and shows the registration report + both hand-off buttons", async () => {
    solveMock.mockResolvedValue(solveResult());
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("photo-to-mesh-btn")).toBeTruthy());
    // The solve was called with the picked images + their names + dense on + sparseMaxDim 1600 (M9).
    expect(solveMock).toHaveBeenCalledTimes(1);
    const [input] = solveMock.mock.calls[0]!;
    expect((input as { images: string[] }).images).toHaveLength(3);
    expect((input as { names: string[] }).names).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect((input as { dense: boolean }).dense).toBe(true);
    expect((input as { sparseMaxDim: number }).sparseMaxDim).toBe(1600);
    expect((screen.getByTestId("photo-sparse-max-dim") as HTMLInputElement).value).toBe("1600");
    expect(screen.getByTestId("photo-status").textContent).toMatch(/3\/3 registered/);
    expect(screen.getByTestId("photo-to-nerf-btn")).toBeTruthy();
  });

  it("PhotoSolveSection sparse-max input overrides the 1600 default on solve", async () => {
    solveMock.mockResolvedValue(solveResult());
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.change(screen.getByTestId("photo-sparse-max-dim"), { target: { value: "640" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(solveMock).toHaveBeenCalledTimes(1));
    expect((solveMock.mock.calls[0]![0] as { sparseMaxDim: number }).sparseMaxDim).toBe(640);
  });

  it("hand-off (b): dense cloud → mesh reconstructs via capture and opens the new project", async () => {
    solveMock.mockResolvedValue(solveResult());
    denseToMeshMock.mockResolvedValue({ meshDocId: "mesh-42", doc: {} as MeshDoc, report: {} });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("photo-to-mesh-btn")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-to-mesh-btn"));
    });
    await waitFor(() => expect(store.opened()).toBe("mesh-42"));
    expect(denseToMeshMock).toHaveBeenCalledTimes(1);
    expect(denseToMeshMock.mock.calls[0]![0]).toBe("ZGVuc2VwbHk="); // the densePly rode through
  });

  it("hand-off (a): poses → NeRF trains a surface (transforms + filename-paired images) and opens it", async () => {
    solveMock.mockResolvedValue(solveResult());
    captureFromPhotosMock.mockResolvedValue({ meshDocId: "mesh-42", doc: {} as MeshDoc, report: {} as never });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("photo-to-nerf-btn")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-to-nerf-btn"));
    });
    await waitFor(() => expect(store.opened()).toBe("mesh-42"));
    expect(captureFromPhotosMock).toHaveBeenCalledTimes(1);
    const [nerfInput] = captureFromPhotosMock.mock.calls[0]!;
    expect((nerfInput as { transformsJson: string }).transformsJson).toContain("frames");
    // The 3 original uploads were paired to the 3 emitted frames by filename (the only NeRF-leg path).
    expect((nerfInput as { images: string[] }).images).toHaveLength(3);
  });

  it("Cancel aborts the in-flight solve and DELETEs the server job", async () => {
    // A solve that yields its job id then never resolves — so the section stays busy and Cancel shows.
    solveMock.mockImplementation(async (_input, opts) => {
      opts?.onJob?.("job-77");
      return new Promise(() => {}) as never; // never resolves
    });
    render(<GenerationPanel />);
    await pickPhotos(3);
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-solve-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("photo-cancel-btn")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("photo-cancel-btn"));
    });
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
    expect(cancelMock.mock.calls[0]![0]).toBe("job-77");
  });
});
