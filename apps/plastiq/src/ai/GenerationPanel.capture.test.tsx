// @vitest-environment jsdom
//
// SPEC-10 (browser client) — the CaptureScanSection: point-cloud scan → mesh via the capture
// service, driven end-to-end through the panel with a REAL file input (FileReader), the REAL
// PLY/XYZ parsers, and the REAL @plastiq/capture submit→poll client over a scripted global fetch:
//  1. health pre-check: an unreachable service shows the start hint and never submits;
//  2. happy path: a .ply upload → /capture submit → poll → GLB persisted as a MeshDoc → opened;
//  3. client-side validation: the server's 16-point floor and /capture's normals requirement
//     block submission with zero network traffic; a points-only file auto-switches to Complete;
//  4. Complete mode routes to POST /complete (points only);
//  5. abort: cancel mid-poll lands on "cancelled", not an error;
//  6. a configured captureBaseURL (settings-capture-url) overrides the default origin for the
//     health pre-check AND the submit→poll conversation — nothing leaks to localhost:8001.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { MeshDoc } from "../store/types.js";

const realFetch = globalThis.fetch;

/** A 16-point oriented ASCII PLY (the server floor is 16 — main.py) with +Z normals. */
const PLY_16 = [
  "ply",
  "format ascii 1.0",
  "element vertex 16",
  "property float x",
  "property float y",
  "property float z",
  "property float nx",
  "property float ny",
  "property float nz",
  "end_header",
  ...Array.from({ length: 16 }, (_, i) => `${i} ${i * 2} ${i * 3} 0 0 1`),
  "",
].join("\n");

/** A 3-point PLY — under the 16-point floor, for the too-few-points check. */
const PLY_3 = PLY_16.replace("element vertex 16", "element vertex 3");

/** 16 points with NO normals (plain 3-column XYZ) — can only feed /complete. */
const XYZ_16 = Array.from({ length: 16 }, (_, i) => `${i} 0 ${i}`).join("\n");

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Upload a scan file through the section's real file input and wait for the parse to land. */
async function uploadScan(name: string, content: string): Promise<void> {
  const file = new File([content], name, { type: "text/plain" });
  await act(async () => {
    fireEvent.change(screen.getByTestId("capture-file-input"), { target: { files: [file] } });
  });
  await waitFor(() => expect(screen.getByTestId("capture-file-name")).toBeTruthy());
}

/** A fetch scripting the full service conversation. `submitPath` is the expected job endpoint;
 * `neverFinish` keeps status at "running" forever (for abort tests).
 * `demoWeights` sets result.demo_weights (M2 complete honesty). */
function installScriptedFetch(opts: {
  submitPath: string;
  neverFinish?: boolean;
  demoWeights?: boolean;
}): {
  spy: ReturnType<typeof vi.fn>;
  submitBody: () => Record<string, unknown> | undefined;
} {
  let body: Record<string, unknown> | undefined;
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    if (u.endsWith(opts.submitPath) && method === "POST") {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return { ok: true, status: 200, json: async () => ({ id: "job-9", state: "queued" }) };
    }
    if (method === "DELETE" && u.includes("/jobs/")) {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (u.endsWith("/status")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "job-9", state: opts.neverFinish ? "running" : "completed" }),
      };
    }
    if (u.endsWith("/result")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          glb_base64: "R0xCdGVzdA==",
          vertices: 8,
          faces: 12,
          ...(opts.demoWeights ? { demo_weights: true } : {}),
        }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, submitBody: () => body };
}

/** Replace the two projectsStore actions the section drives, recording their inputs. */
function stubProjectsStore(): { persisted: () => MeshDoc | null; opened: () => string | null } {
  let doc: MeshDoc | null = null;
  let openedId: string | null = null;
  useProjectsStore.setState({
    createMeshProject: async (d: MeshDoc) => {
      doc = d;
      return "mesh-99";
    },
    open: async (id: string) => {
      openedId = id;
    },
  });
  return { persisted: () => doc, opened: () => openedId };
}

describe("CaptureScanSection — health pre-check blocks submission", () => {
  it("an unreachable capture service shows the start hint and never submits the job", async () => {
    const spy: ReturnType<typeof vi.fn> = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    render(<GenerationPanel />);
    await uploadScan("scan.ply", PLY_16);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("capture-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8001");
      expect(err).toContain("start it with");
      expect(err).toContain("services/capture");
    });
    // Exactly ONE request went out — the health probe; the job was never submitted.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe("http://localhost:8001/health");
    expect((screen.getByTestId("capture-run-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("CaptureScanSection — submit → poll → MeshDoc happy path", () => {
  it("parses a .ply, POSTs /capture, polls to completion, persists the GLB MeshDoc, and opens it", async () => {
    const { submitBody } = installScriptedFetch({ submitPath: "/capture" });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadScan("scan.ply", PLY_16);
    expect(screen.getByTestId("capture-file-name").textContent).toContain("16 pts, normals");

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => expect(store.opened()).toBe("mesh-99"));
    const doc = store.persisted();
    expect(doc).not.toBeNull();
    expect(doc!.glb).toBe("R0xCdGVzdA==");
    expect(doc!.kind).toBe("mesh");
    expect(doc!.source).toEqual({ mode: "photos3d", providerId: "capture" });
    expect(doc!.name).toBe("Scanned mesh");

    // The submit body is the parsed cloud in the server's wire schema (raw Nx3 arrays).
    const body = submitBody();
    expect(body?.points).toHaveLength(16);
    expect(body?.normals).toHaveLength(16);
    expect((body?.points as number[][])[1]).toEqual([1, 2, 3]);
    expect((body?.normals as number[][])[0]).toEqual([0, 0, 1]);

    // The section resets for the next scan (file cleared, idle again, no error).
    await waitFor(() => expect(screen.queryByTestId("capture-file-name")).toBeNull());
    expect(screen.queryByTestId("capture-error")).toBeNull();
    expect((screen.getByTestId("capture-run-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Complete mode routes a points-only scan to POST /complete (auto-selected when normals are absent)", async () => {
    const { spy, submitBody } = installScriptedFetch({ submitPath: "/complete" });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadScan("partial.xyz", XYZ_16);
    expect(screen.getByTestId("capture-file-name").textContent).toContain("16 pts");
    expect(screen.getByTestId("capture-file-name").textContent).not.toContain("normals");

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => expect(store.opened()).toBe("mesh-99"));
    expect(store.persisted()!.source.providerId).toBe("capture:complete");
    expect(store.persisted()!.name).toBe("Completed scan");
    expect(submitBody()).toEqual({ points: Array.from({ length: 16 }, (_, i) => [i, 0, i]) });
    // …and the job endpoint really was /complete, after the /health probe.
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://localhost:8001/complete");
    expect(urls).not.toContain("http://localhost:8001/capture");
  });
});

describe("CaptureScanSection — client-side validation (zero network on failure)", () => {
  it("blocks a scan under the server's 16-point floor before any request", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    render(<GenerationPanel />);
    await uploadScan("tiny.ply", PLY_3);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    expect(screen.getByTestId("capture-error").textContent).toContain("Too few points (3)");
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks Capture mode for a normals-less file with a pointed message (and no request)", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    render(<GenerationPanel />);
    await uploadScan("partial.xyz", XYZ_16);
    // The upload auto-switched to Complete; force Capture back on to hit the guard.
    fireEvent.click(screen.getByTestId("capture-mode-capture"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    const err = screen.getByTestId("capture-error").textContent ?? "";
    expect(err).toContain("no normals");
    expect(err).toContain("Complete");
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces a parser failure (binary PLY) in the error slot and keeps the run disabled", async () => {
    render(<GenerationPanel />);
    const file = new File([PLY_16.replace("format ascii 1.0", "format binary_little_endian 1.0")], "bin.ply", {
      type: "text/plain",
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("capture-file-input"), { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(screen.getByTestId("capture-error").textContent).toContain("binary PLY");
    });
    expect(screen.queryByTestId("capture-file-name")).toBeNull();
    expect((screen.getByTestId("capture-run-btn") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("CaptureScanSection — configured captureBaseURL (settings override)", () => {
  const CUSTOM = "http://capture.lan:9321";

  /** Persist the custom capture URL into the settings slice the section reads at run time. */
  function configureCaptureURL(): void {
    useAiStore.setState({
      settings: { ...useAiStore.getState().settings!, captureBaseURL: CUSTOM },
      loaded: true,
    });
  }

  it("health pre-check, /capture submit, and the status/result polls ALL hit the configured origin", async () => {
    configureCaptureURL();
    const { spy } = installScriptedFetch({ submitPath: "/capture" });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadScan("scan.ply", PLY_16);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => expect(store.opened()).toBe("mesh-99"));
    const urls = spy.mock.calls.map((c) => String(c[0]));
    // The full conversation, in order: probe → submit → poll → result — all on the custom origin.
    expect(urls[0]).toBe(`${CUSTOM}/health`);
    expect(urls[1]).toBe(`${CUSTOM}/capture`);
    expect(urls).toContain(`${CUSTOM}/jobs/job-9/status`);
    expect(urls[urls.length - 1]).toBe(`${CUSTOM}/jobs/job-9/result`);
    // …and NOTHING leaked to the default origin.
    expect(urls.every((u) => u.startsWith(`${CUSTOM}/`))).toBe(true);
  });

  it("an unreachable configured service probes the CONFIGURED /health and names that URL in the hint", async () => {
    configureCaptureURL();
    const spy: ReturnType<typeof vi.fn> = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    render(<GenerationPanel />);
    await uploadScan("scan.ply", PLY_16);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("capture-error").textContent).toContain(`unreachable at ${CUSTOM}`);
    });
    // Exactly ONE request — the health probe against the configured origin, not localhost:8001.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe(`${CUSTOM}/health`);
  });
});

describe("CaptureScanSection — abort + server cancel (M4)", () => {
  it("Cancel mid-poll DELETEs the job and lands on 'cancelled' (no error)", async () => {
    const { spy } = installScriptedFetch({ submitPath: "/capture", neverFinish: true });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadScan("scan.ply", PLY_16);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });
    await waitFor(() => expect(screen.getByTestId("capture-cancel-btn")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-cancel-btn"));
    });

    // Server-side cancel: DELETE /jobs/job-9 (force-stops the spawn worker).
    await waitFor(() => {
      const del = spy.mock.calls.find(
        (c) => String(c[0]).includes("/jobs/job-9") && (c[1]?.method ?? "").toUpperCase() === "DELETE",
      );
      expect(del).toBeTruthy();
    });

    // The client notices the abort on its next poll wake-up (1s interval) and throws AbortError,
    // which the section renders as a "cancelled" status — not an error.
    await waitFor(() => expect(screen.getByTestId("capture-status").textContent).toBe("cancelled"), {
      timeout: 4000,
    });
    expect(screen.queryByTestId("capture-error")).toBeNull();
    expect(store.opened()).toBeNull();
    expect((screen.getByTestId("capture-run-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("CaptureScanSection — demo weights honesty (M2)", () => {
  it("surfaces a demo-weights banner when /complete returns demo_weights: true", async () => {
    installScriptedFetch({ submitPath: "/complete", demoWeights: true });
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadScan("partial.xyz", XYZ_16);

    await act(async () => {
      fireEvent.click(screen.getByTestId("capture-run-btn"));
    });

    await waitFor(() => expect(store.opened()).toBe("mesh-99"));
    await waitFor(() => {
      const banner = screen.getByTestId("capture-demo-weights").textContent ?? "";
      expect(banner).toMatch(/Demo completion weights/i);
      expect(banner).toMatch(/CAPTURE_COMPLETION_CHECKPOINT/i);
    });
    expect(screen.getByTestId("capture-status").textContent).toMatch(/demo weights/i);
  });
});
