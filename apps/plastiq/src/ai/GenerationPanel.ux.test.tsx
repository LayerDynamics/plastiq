// @vitest-environment jsdom
//
// AI/service UX — GenerationPanel behaviors around failure and continuity:
//  1. error translation + Retry: a provider failure (relayed through the REAL agent
//     loop) surfaces as an actionable message (raw kept collapsed) and the failed run
//     is retryable verbatim (same prompt reaches the provider again);
//  2. transcript replay: the persisted per-project conversation hydrates the visible
//     transcript on mount / project change, marked as prior-session lines;
//  3. service health pre-checks: mesh-convert and NeRF capture GET /health first and
//     refuse to submit when the service is unreachable (error slot names the URL +
//     start command; the job endpoint is never hit).
//
// The chat provider is mocked at the registry seam (buildProvider) so the real
// runGeneration/agentRunner wiring runs without a network; /health is driven by a
// fake global fetch.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { ChatMessage, ChatStreamRequest } from "./providers/types.js";
import type { MeshDoc } from "../store/types.js";
import type { BuildOutcome } from "../worker/bridge.js";
import type { TransferMesh } from "../worker/protocol.js";

/** A minimal but well-formed built mesh — one triangle. The §2.12.2 gate only
 * needs the build to have produced geometry with no failed features, but the
 * seam's contract is a real TransferMesh, so the stub honours it. */
const STUB_MESH: TransferMesh = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceGroups: [],
  edges: [],
  vertexIds: [],
  vertexPositions: new Float32Array([]),
};

// Controllable fake chat provider behind the registry seam — the panel + the REAL
// agent loop drive it; tests flip `behavior`/`errorText` and inspect `requests`.
const providerControl = vi.hoisted(() => ({
  behavior: "fail" as "fail" | "ok",
  errorText: "TypeError: Failed to fetch",
  requests: [] as ChatStreamRequest[],
}));
vi.mock("./providers/registry.js", () => ({
  // The panel threads the decision-21 key indirection into toProviderSettings; the
  // fake provider ignores keys, so a no-key resolver stands in for keyResolverFor.
  keyResolverFor: () => () => undefined,
  buildProvider: () => ({
    id: "openai-compatible" as const,
    model: "fake-model",
    supportsVision: false,
    supportsTools: true,
    async *stream(req: ChatStreamRequest) {
      // Snapshot: the agent loop keeps mutating the same messages array after the turn.
      providerControl.requests.push({ ...req, messages: [...req.messages] });
      if (providerControl.behavior === "fail") {
        yield { type: "error" as const, error: providerControl.errorText };
        yield { type: "done" as const, finishReason: "error" as const };
        return;
      }
      yield { type: "text-delta" as const, text: "Built it." };
      yield { type: "done" as const, finishReason: "stop" as const };
    },
  }),
}));

// The NeRF flow trains server-side; mock the package client so the health pre-check is
// the ONLY network touchpoint (and assert the train job is never submitted). cancelJob is
// mocked too (src/ai/nerf.ts imports it for the panel's Cancel); no test here cancels.
const nerfMocks = vi.hoisted(() => ({
  trainNerf: vi.fn(async () => ({
    glb: "R0xCdGVzdA==",
    report: { method: "neus", iters: 100, psnr: 20, vertices: 10, faces: 20 },
  })),
  cancelJob: vi.fn(async () => {}),
}));
vi.mock("@plastiq/nerf", () => ({ trainNerf: nerfMocks.trainNerf, cancelJob: nerfMocks.cancelJob }));

const realFetch = globalThis.fetch;

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
  // The viewport's build seam. It must return a real BuildOutcome shape: the
  // §2.12.2 validate-then-commit gate probes it before landing service STEP, and
  // a document that doesn't build is (correctly) refused. The previous stub
  // resolved to `null` — never a valid BuildOutcome, just never exercised.
  (globalThis as { __plastiqBuild?: () => Promise<BuildOutcome> }).__plastiqBuild = () =>
    Promise.resolve({ mesh: STUB_MESH, statuses: [{ featureId: "f1", status: "ok" }] });
  providerControl.behavior = "fail";
  providerControl.errorText = "TypeError: Failed to fetch";
  providerControl.requests.length = 0;
  nerfMocks.trainNerf.mockClear();
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Type a prompt and send it (the chat path). */
const sendPrompt = async (text: string): Promise<void> => {
  fireEvent.change(screen.getByTestId("generation-prompt"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("generation-send"));
  });
};

describe("GenerationPanel — provider failures are translated and retryable", () => {
  it("a connection failure surfaces as an actionable can't-reach message with the raw kept secondary", async () => {
    render(<GenerationPanel />);
    await sendPrompt("make a cube");

    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("Can't reach Ollama (local, no key) at http://localhost:11434/v1");
    });
    const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
    expect(transcript).toContain("is it running?");
    expect(transcript).toContain("ollama serve"); // the Ollama-specific start hint
    // The raw provider message stays available, collapsed under the friendly line.
    expect(screen.getByTestId("error-detail").textContent).toContain("TypeError: Failed to fetch");
    // The failed run is retryable.
    expect(screen.getByTestId("generation-retry")).toBeTruthy();
  });

  it("an auth failure points at the API key in Provider settings", async () => {
    providerControl.errorText = "401 Incorrect API key provided";
    render(<GenerationPanel />);
    await sendPrompt("make a cube");

    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("unauthorized");
      expect(transcript).toContain("Provider settings");
    });
  });

  it("Retry re-runs the SAME prompt through the provider; a success clears the affordance", async () => {
    render(<GenerationPanel />);
    await sendPrompt("make a cube");
    await waitFor(() => expect(screen.getByTestId("generation-retry")).toBeTruthy());
    expect(providerControl.requests).toHaveLength(1);

    providerControl.behavior = "ok";
    await act(async () => {
      fireEvent.click(screen.getByTestId("generation-retry"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("generation-transcript").textContent).toContain("Built it.");
    });
    // The retry reached the provider with the same user prompt (not an empty input).
    expect(providerControl.requests).toHaveLength(2);
    const retried = providerControl.requests[1]!.messages;
    const last = retried[retried.length - 1] as ChatMessage;
    expect(last).toMatchObject({ role: "user", content: "make a cube" });
    // A successful run clears the retry affordance.
    await waitFor(() => expect(screen.queryByTestId("generation-retry")).toBeNull());
  });

  it("the system prompt ships the creative guidance — the panel always offers create_mesh (6-M2)", async () => {
    providerControl.behavior = "ok";
    render(<GenerationPanel />);
    await sendPrompt("make a cube");
    await waitFor(() => expect(providerControl.requests).toHaveLength(1));
    // buildTurnTools always wires create_mesh, and runGeneration derives the creative
    // guidance from that tool surface — so the prompt teaches the tool it offers.
    expect(providerControl.requests[0]!.system).toContain("create_mesh");
  });
});

describe("GenerationPanel — transcript replay from the persisted conversation (R5.1)", () => {
  it("hydrates the visible transcript on mount, marked as prior-session lines (tool turns excluded)", () => {
    useAiStore.setState({
      conversation: {
        messages: [
          { role: "user", content: "make a bracket" },
          { role: "assistant", content: "Done — a 40×20 bracket." },
          { role: "tool", toolCallId: "t1", content: "internal tool result" },
        ],
        trace: [],
      },
      conversationProjectId: "p1",
    });
    render(<GenerationPanel />);

    const transcript = screen.getByTestId("generation-transcript");
    expect(transcript.textContent).toContain("earlier messages in this project");
    expect(transcript.textContent).toContain("> make a bracket");
    expect(transcript.textContent).toContain("Done — a 40×20 bracket.");
    // Tool-loop plumbing is not replayed.
    expect(transcript.textContent).not.toContain("internal tool result");
    // Prior-session lines are rendered distinguishably (header + 2 messages).
    expect(transcript.querySelectorAll('[data-prior="true"]')).toHaveLength(3);
  });

  it("switching projects re-hydrates the transcript from the new project's history", async () => {
    useAiStore.setState({
      conversation: { messages: [{ role: "user", content: "old project prompt" }], trace: [] },
      conversationProjectId: "p1",
    });
    render(<GenerationPanel />);
    expect(screen.getByTestId("generation-transcript").textContent).toContain("old project prompt");

    // openConversation sets the loaded conversation + project id together; mirror that.
    act(() => {
      useAiStore.setState({
        conversation: { messages: [{ role: "assistant", content: "welcome back to p2" }], trace: [] },
        conversationProjectId: "p2",
      });
    });
    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("welcome back to p2");
      expect(transcript).not.toContain("old project prompt");
    });
  });
});

describe("GenerationPanel — service health pre-checks block submission (GET /health)", () => {
  const installDeadFetch = (): ReturnType<typeof vi.fn> => {
    const spy = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  };

  it("mesh-convert: an unreachable reconstruction service shows the start hint and never submits", async () => {
    const fetchSpy = installDeadFetch();
    const meshDoc: MeshDoc = { kind: "mesh", name: "gen", glb: "R0xC", source: { mode: "img3d", providerId: "fal:tripo" } };
    useProjectsStore.setState({ activeMeshDoc: meshDoc });
    render(<GenerationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-run"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("mesh-convert-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8000");
      expect(err).toContain("start it with");
    });
    // Exactly ONE request went out — the health probe; the job was never submitted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://localhost:8000/health");
    // The section is idle again (not stuck busy).
    expect((screen.getByTestId("mesh-convert-run") as HTMLButtonElement).disabled).toBe(false);
  });

  it("NeRF capture: an unreachable service shows the start hint and never trains", async () => {
    const fetchSpy = installDeadFetch();
    render(<GenerationPanel />);

    const transforms = new File([JSON.stringify({ frames: [{ file_path: "v0.png" }] })], "transforms.json", {
      type: "application/json",
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-transforms-input"), { target: { files: [transforms] } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-images-input"), {
        target: { files: [new File([new Uint8Array([1, 2, 3])], "v0.png", { type: "image/png" })] },
      });
    });
    await waitFor(() => expect((screen.getByTestId("nerf-capture-btn") as HTMLButtonElement).disabled).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByTestId("nerf-capture-btn"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("nerf-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8002");
      expect(err).toContain("start it with");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://localhost:8002/health");
    expect(nerfMocks.trainNerf).not.toHaveBeenCalled();
  });
});

describe("MeshConvertSection — converted status carries the recognition fingerprint (SPEC-8 8-M2)", () => {
  const meshDoc: MeshDoc = { kind: "mesh", name: "gen", glb: "R0xC", source: { mode: "img3d", providerId: "fal:tripo" } };
  const baseReport = {
    triangles_in: 12,
    triangles_used: 12,
    faces_built: 6,
    planar_faces: 6,
    is_solid: true,
    is_valid: true,
    method: "fitted",
  };

  /** Script the full reconstruction conversation (health → submit → status → result)
   * so the REAL reconstructMesh client runs the convert to completion. */
  const installReconstructFetch = (report: Record<string, unknown>): void => {
    const json = (body: unknown): unknown => ({ ok: true, status: 200, json: async () => body });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) return json({ status: "ok" });
      if (u.endsWith("/reconstruct")) return json({ id: "job-1", state: "queued" });
      if (u.endsWith("/status")) return json({ id: "job-1", state: "completed" });
      if (u.endsWith("/result")) return json({ step: "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;", report });
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
  };

  const convert = async (): Promise<string> => {
    useProjectsStore.setState({ activeMeshDoc: meshDoc, status: "" });
    render(<GenerationPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-run"));
    });
    await waitFor(() => expect(useProjectsStore.getState().status).toContain("converted to CAD"));
    return useProjectsStore.getState().status;
  };

  it("appends the tangent-region fingerprint when the server reports it", async () => {
    installReconstructFetch({ ...baseReport, surface_deviation: 0.0041, fidelity_tol: 0.01, tangent_regions: 3 });
    const status = await convert();
    expect(status).toBe("converted to CAD — 6 faces, solid, fidelity good (Δ0.0041), 3 tangent regions");
  });

  it("omits the fingerprint for an older server (tangent_regions absent)", async () => {
    installReconstructFetch(baseReport);
    const status = await convert();
    expect(status).toContain("converted to CAD — 6 faces, solid");
    expect(status).not.toContain("tangent region");
  });
});

describe("MeshConvertSection — Fit smooth CAD (NURBS) alongside Convert to CAD (SPEC-12 FR-8)", () => {
  const meshDoc: MeshDoc = { kind: "mesh", name: "blob", glb: "R0xC", source: { mode: "img3d", providerId: "fal:tripo" } };
  const baseReport = {
    patches: 1,
    fitted_patches: 1,
    faceted_patches: 0,
    control_points: 256,
    degree_u: 3,
    degree_v: 3,
    iters: 200,
    chamfer: 0.001,
    scd: 0.002,
    rms_deviation: 0.0003,
    max_deviation: 0.0008,
    fidelity_tol: 0.01,
    is_solid: false,
    is_valid: true,
    mode: "open",
  };

  /** Script the full NURBS fit conversation (health → /fit → status → result) so the REAL
   * @plastiq/nurbs client runs the fit to completion (the reconstruct precedent above). */
  const installNurbsFetch = (report: Record<string, unknown>): void => {
    const json = (body: unknown): unknown => ({ ok: true, status: 200, json: async () => body });
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/health")) return json({ status: "ok" });
      if (u.endsWith("/fit")) return json({ id: "job-1", state: "queued" });
      if (u.endsWith("/status")) return json({ id: "job-1", state: "completed" });
      if (u.endsWith("/result"))
        return json({ step: "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;", surfaces: [], report });
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;
  };

  const fit = async (): Promise<string> => {
    useProjectsStore.setState({ activeMeshDoc: meshDoc, status: "" });
    render(<GenerationPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-nurbs-run"));
    });
    await waitFor(() => expect(useProjectsStore.getState().status).toContain("fitted smooth CAD"));
    return useProjectsStore.getState().status;
  };

  it("renders the NURBS action alongside Convert to CAD in the mesh section", () => {
    useProjectsStore.setState({ activeMeshDoc: meshDoc });
    render(<GenerationPanel />);
    expect(screen.getByTestId("mesh-convert-run")).toBeTruthy();
    const btn = screen.getByTestId("mesh-nurbs-run") as HTMLButtonElement;
    expect(btn.textContent).toContain("Fit smooth CAD (NURBS)");
  });

  it("a completed open-mode fit loads the STEP doc and labels the shell honestly (isSolid=false)", async () => {
    installNurbsFetch(baseReport);
    const status = await fit();
    expect(status).toContain("fitted smooth CAD (NURBS)");
    expect(status).toContain("shell (not a solid)");
    // Switched out of mesh mode into the new B-rep document.
    expect(useProjectsStore.getState().activeMeshDoc).toBeNull();
    expect(useProjectsStore.getState().currentName).toBe("blob");
  });

  it("surfaces faceted fallback patches in the result message (facetedPatches > 0)", async () => {
    installNurbsFetch({ ...baseReport, patches: 6, fitted_patches: 4, faceted_patches: 2, is_solid: true, mode: "closed" });
    const status = await fit();
    expect(status).toContain("2 of 6 faceted (fallback)");
    expect(status).not.toContain("not a solid");
  });

  it("an unreachable NURBS service shows the start hint and never submits", async () => {
    const spy = vi.fn(async (_url: string | URL | Request) => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    useProjectsStore.setState({ activeMeshDoc: meshDoc });
    render(<GenerationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-nurbs-run"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("mesh-convert-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8003");
      expect(err).toContain("start it with");
    });
    // Exactly ONE request went out — the health probe; the fit was never submitted.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe("http://localhost:8003/health");
    expect((screen.getByTestId("mesh-nurbs-run") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("MeshConvertSection — Cancel aborts polling AND DELETEs the server job (M4b)", () => {
  const meshDoc: MeshDoc = {
    kind: "mesh",
    name: "gen",
    glb: "R0xC",
    source: { mode: "img3d", providerId: "fal:tripo" },
  };

  /** Script health + submit, then hang on status until AbortSignal fires; record DELETEs.
   * `submitted` flips once the job id is returned (onJob handle is live for Cancel). */
  function installHangingJob(opts: { submitPath: string; jobId: string }): {
    deletes: { url: string; method: string; auth?: string }[];
    submitted: () => boolean;
  } {
    const deletes: { url: string; method: string; auth?: string }[] = [];
    let submitted = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        deletes.push({
          url: u,
          method,
          auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"],
        });
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (u.endsWith(opts.submitPath)) {
        submitted = true;
        return { ok: true, status: 200, json: async () => ({ id: opts.jobId, state: "queued" }) };
      }
      if (u.endsWith("/status")) {
        // Hang until the panel aborts — keeps Cancel visible and jobId live for DELETE.
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const abort = (): void => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort);
        });
      }
      throw new Error(`unexpected url ${u} method ${method}`);
    }) as unknown as typeof fetch;
    return { deletes, submitted: () => submitted };
  }

  it("Convert to CAD: Cancel DELETEs reconstruct /jobs/{id} with the persisted key", async () => {
    useAiStore.setState({
      settings: {
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        reconstructApiKey: "recon-secret",
      },
      loaded: true,
    });
    const { deletes, submitted } = installHangingJob({ submitPath: "/reconstruct", jobId: "job-recon-42" });
    useProjectsStore.setState({ activeMeshDoc: meshDoc, status: "" });
    render(<GenerationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-run"));
    });
    // Wait until submit returned (onJob has the cancel handle) before clicking Cancel.
    await waitFor(() => expect(submitted()).toBe(true));
    await waitFor(() => expect(screen.getByTestId("mesh-convert-cancel")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-cancel"));
    });

    await waitFor(() => expect(deletes.some((d) => d.method === "DELETE")).toBe(true));
    expect(deletes[0]?.url).toBe("http://localhost:8000/jobs/job-recon-42");
    expect(deletes[0]?.auth).toBe("Bearer recon-secret");
    // Abort is a clean cancel — error slot stays empty.
    expect(screen.queryByTestId("mesh-convert-error")).toBeNull();
  });

  it("Fit smooth CAD: Cancel DELETEs nurbs /jobs/{id} with the persisted key", async () => {
    useAiStore.setState({
      settings: {
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        nurbsApiKey: "nurbs-secret",
      },
      loaded: true,
    });
    const { deletes, submitted } = installHangingJob({ submitPath: "/fit", jobId: "job-nurbs-7" });
    useProjectsStore.setState({ activeMeshDoc: meshDoc, status: "" });
    render(<GenerationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-nurbs-run"));
    });
    await waitFor(() => expect(submitted()).toBe(true));
    await waitFor(() => expect(screen.getByTestId("mesh-convert-cancel")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-cancel"));
    });

    await waitFor(() => expect(deletes.some((d) => d.method === "DELETE")).toBe(true));
    expect(deletes[0]?.url).toBe("http://localhost:8003/jobs/job-nurbs-7");
    expect(deletes[0]?.auth).toBe("Bearer nurbs-secret");
    expect(screen.queryByTestId("mesh-convert-error")).toBeNull();
  });
});
