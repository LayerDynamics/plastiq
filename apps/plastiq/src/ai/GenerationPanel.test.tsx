// @vitest-environment jsdom
//
// SPEC-6 R2.4/R4.3 — GenerationPanel component test (jsdom + RTL). Focus: the creative
// mesh-gen (fal) key affordance is REACHABLE by a real user — without it, create_mesh
// could never authenticate, so wiring the tool alone would be a feature no user can run.
// Asserts the field renders, starts "not configured", and saving a key flips it to
// configured (driving the real aiStore.save → settings).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { EMPTY_SESSION_USAGE } from "./usage.js";
import type { MeshDoc } from "../store/types.js";
import type * as NerfPkg from "@plastiq/nerf";

// The NeRF capture flow trains server-side; mock the package's trainNerf so the tests drive the
// real component (file inputs → captureFromPhotos → persist → open) without a network/server.
// cancelJob stays REAL (spread from the actual module): the Cancel test asserts the DELETE it
// issues over the scripted global fetch — the actual wire contract, not a mock call count.
const nerfPkg = vi.hoisted(() => ({
  trainNerf: vi.fn(async (_input: unknown, _opts?: NerfPkg.NerfOptions) => ({
    glb: "R0xCdGVzdA==",
    report: { method: "neus" as const, iters: 100, psnr: 20, vertices: 10, faces: 20 },
  })),
}));
vi.mock("@plastiq/nerf", async (importOriginal) => ({
  ...(await importOriginal<typeof NerfPkg>()),
  trainNerf: nerfPkg.trainNerf,
}));

beforeEach(() => {
  // A provider is configured (past first-run) and no mesh doc is open → the main panel.
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
    sessionUsage: EMPTY_SESSION_USAGE,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
});

describe("GenerationPanel — first run shows the neutral chooser (FR-5a, isFirstRun)", () => {
  it("renders the provider chooser (not the prompt) when no settings are persisted", () => {
    useAiStore.setState({ settings: null, loaded: true });
    render(<GenerationPanel />);
    expect(screen.getByTestId("ai-setup")).toBeTruthy();
    expect(screen.queryByTestId("generation-prompt")).toBeNull();
  });
});

describe("GenerationPanel — first-run Ollama detection (6-L3 / R-10)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("detecting a reachable Ollama lists its installed models and saves the chosen one", async () => {
    useAiStore.setState({ settings: null, loaded: true });
    // Script GET /api/tags with two installed models (one tool-capable, one not).
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith("/api/tags")) {
        return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen2.5:14b" }, { name: "phi3:mini" }] }) };
      }
      throw new Error(`unexpected ${String(url)}`);
    }) as unknown as typeof fetch;

    render(<GenerationPanel />);
    // No blind save button — the neutral detect entry instead.
    expect(screen.getByTestId("ai-detect-ollama")).toBeTruthy();
    expect(screen.queryByTestId("ai-use-ollama")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-detect-ollama"));
    });

    // Detection populated the picker with the ACTUAL installed models (tool-capable first).
    const picker = await screen.findByTestId("ai-ollama-model");
    const opts = Array.from((picker as HTMLSelectElement).querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual(["qwen2.5:14b", "phi3:mini"]);
    expect((picker as HTMLSelectElement).value).toBe("qwen2.5:14b");

    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-use-ollama"));
    });
    // The picked (existing) model reaches settings — not a blind fixed default.
    await waitFor(() => {
      expect(useAiStore.getState().settings?.model).toBe("qwen2.5:14b");
    });
    expect(useAiStore.getState().settings?.providerKey).toBe("ollama");
    expect(useAiStore.getState().settings?.baseURL).toBe("http://localhost:11434/v1");
  });

  it("an unreachable Ollama shows the start/CORS hint instead of silently saving a dead config", async () => {
    useAiStore.setState({ settings: null, loaded: true });
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    render(<GenerationPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("ai-detect-ollama"));
    });

    const hint = await screen.findByTestId("ai-ollama-unreachable");
    expect(hint.textContent).toContain("ollama serve");
    expect(hint.textContent).toContain("OLLAMA_ORIGINS");
    // Nothing was persisted — the chooser is still showing, no dead config saved.
    expect(useAiStore.getState().settings).toBeNull();
    expect(screen.queryByTestId("ai-use-ollama")).toBeNull();
  });
});

describe("GenerationPanel — session usage readout (6-L2)", () => {
  it("renders the session-cumulative total (survives across runs, not reset per generation)", () => {
    // Seed a session that already spanned two runs — the readout must show the SESSION total,
    // not just the last run's per-run number (which resets each generation).
    useAiStore.setState({
      sessionUsage: { turns: 2, inputTokens: 150, outputTokens: 30, totalTokens: 180, paidJobs: 1 },
    });
    render(<GenerationPanel />);
    const readout = screen.getByTestId("generation-usage-session");
    expect(readout.textContent).toContain("session 180 tok");
    expect(readout.textContent).toContain("2 runs");
    expect(readout.textContent).toContain("1 paid");
  });

  it("shows no session readout before any run", () => {
    render(<GenerationPanel />);
    expect(screen.queryByTestId("generation-usage-session")).toBeNull();
  });
});

describe("GenerationPanel — creative mesh-gen key is reachable", () => {
  it("renders the prompt and the creative-key affordance for a configured provider", () => {
    render(<GenerationPanel />);
    expect(screen.getByTestId("generation-prompt")).toBeTruthy();
    expect(screen.getByTestId("creative-key")).toBeTruthy();
    // Honest initial state: not configured (no fal key, no proxy).
    expect(screen.getByTestId("creative-key").textContent).toContain("not configured");
  });

  it("saving a fal key flips the affordance to configured (key reaches settings)", async () => {
    render(<GenerationPanel />);
    fireEvent.change(screen.getByTestId("creative-key-input"), { target: { value: "fal-secret" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("creative-key-save"));
    });
    // Wait on the real persisted value (the async aiStore.save → IndexedDB write). NB:
    // "configured" is a substring of "not configured", so assert on settings, not text.
    await waitFor(() => {
      expect(useAiStore.getState().settings?.apiKeys.fal).toBe("fal-secret");
    });
    expect(screen.getByTestId("creative-key").textContent).toContain("✓ configured");
  });
});

describe("GenerationPanel — image attach + route toggle (FR-10a/FR-10b)", () => {
  const attachImage = async (name = "ref.png"): Promise<void> => {
    const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("attach-input"), { target: { files: [file] } });
    });
    await waitFor(() => expect(screen.getByTestId("attach-name")).toBeTruthy());
  };

  it("attaching an image reveals the route toggle; the creative route reveals a provider picker", async () => {
    render(<GenerationPanel />);
    // No image yet → no route toggle.
    expect(screen.queryByTestId("attach-route")).toBeNull();

    await attachImage();
    expect(screen.getByTestId("attach-name").textContent).toContain("ref.png");
    expect(screen.getByTestId("attach-route-parametric")).toBeTruthy();
    expect(screen.getByTestId("attach-route-creative")).toBeTruthy();
    // Parametric is the default → no 3D-gen provider picker yet.
    expect(screen.queryByTestId("attach-mesh-provider")).toBeNull();

    fireEvent.click(screen.getByTestId("attach-route-creative"));
    // Creative image→3D needs a 3D-gen provider — the picker appears (img3d-capable only).
    const picker = screen.getByTestId("attach-mesh-provider") as HTMLSelectElement;
    expect(picker).toBeTruthy();
    expect(picker.querySelectorAll("option").length).toBeGreaterThan(0);
  });

  it("clearing an attachment removes the route toggle", async () => {
    render(<GenerationPanel />);
    await attachImage();
    fireEvent.click(screen.getByTestId("attach-clear"));
    await waitFor(() => expect(screen.queryByTestId("attach-route")).toBeNull());
  });

  it("a parametric image on a non-vision model is DISABLED with a message, not silently dropped", async () => {
    // qwen2.5 over openai-compatible is not vision-capable (supportsVision=false).
    (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
    render(<GenerationPanel />);
    await attachImage();
    // Keep the default parametric route, then run.
    await act(async () => {
      fireEvent.click(screen.getByTestId("generation-send"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("generation-transcript").textContent).toContain("can’t see images");
    });
    delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
  });
});

describe("GenerationPanel — NeRF capture opens the mesh so Convert-to-CAD becomes reachable (SPEC-11 N11.3)", () => {
  // Capture pre-checks GET <nerfBaseURL>/health before submitting (errorHints.ts); answer
  // "healthy" so the test stays about the persist→open flow, not service reachability.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const selectFile = async (testid: string, file: File): Promise<void> => {
    await act(async () => {
      fireEvent.change(screen.getByTestId(testid), { target: { files: [file] } });
    });
  };

  // The file inputs read via FileReader (async); the Capture button enables only once both reads land.
  const captureBtn = (): HTMLButtonElement => screen.getByTestId("nerf-capture-btn") as HTMLButtonElement;
  const waitForCaptureEnabled = async (): Promise<void> => {
    await waitFor(() => expect(captureBtn().disabled).toBe(false));
  };

  /** Stub the persistence methods (the real ones need the sql.js store, unavailable in jsdom).
   * createMeshProject deliberately does NOT set activeMeshDoc — mirroring the real contract — so the
   * panel only flips to mesh-convert if the component actually calls open(id). That IS the regression. */
  const installStoreStubs = (): void => {
    let saved: MeshDoc | null = null;
    useProjectsStore.setState({
      activeMeshDoc: null,
      createMeshProject: async (doc) => {
        saved = doc;
        return "mesh-1";
      },
      open: async (id) => {
        if (id === "mesh-1" && saved) useProjectsStore.setState({ activeMeshDoc: saved });
      },
    });
  };

  it("after a successful capture, the panel switches to MeshConvertSection", async () => {
    installStoreStubs();
    render(<GenerationPanel />);
    expect(screen.getByTestId("nerf-capture")).toBeTruthy();
    expect(screen.queryByTestId("mesh-convert")).toBeNull();

    const transforms = new File([JSON.stringify({ frames: [{ file_path: "v0.png" }] })], "transforms.json", {
      type: "application/json",
    });
    await selectFile("nerf-transforms-input", transforms);
    await selectFile("nerf-images-input", new File([new Uint8Array([1, 2, 3])], "v0.png", { type: "image/png" }));
    await waitForCaptureEnabled();

    await act(async () => {
      fireEvent.click(captureBtn());
    });

    // The captured mesh is persisted AND opened → activeMeshDoc set → the panel renders the
    // "Convert to CAD" section. (Regression guard: createMeshProject alone does NOT open the doc.)
    await waitFor(() => expect(screen.getByTestId("mesh-convert")).toBeTruthy());
    expect(useProjectsStore.getState().activeMeshDoc?.source.mode).toBe("photos3d");
  });

  it("blocks capture when the image count does not match the transforms frames", async () => {
    installStoreStubs();
    render(<GenerationPanel />);

    const transforms = new File([JSON.stringify({ frames: [{ file_path: "a" }, { file_path: "b" }] })], "t.json", {
      type: "application/json",
    });
    await selectFile("nerf-transforms-input", transforms); // 2 frames
    await selectFile("nerf-images-input", new File([new Uint8Array([1])], "a.png", { type: "image/png" })); // 1 image
    await waitForCaptureEnabled();

    await act(async () => {
      fireEvent.click(captureBtn());
    });

    await waitFor(() => expect(screen.getByTestId("nerf-error").textContent).toContain("must match"));
    expect(screen.queryByTestId("mesh-convert")).toBeNull();
  });

  it("Cancel aborts polling AND best-effort DELETEs the server-side job with the persisted key (11-M2)", async () => {
    installStoreStubs();
    useAiStore.setState({
      settings: {
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        nerfApiKey: "nerf-secret",
      },
      loaded: true,
    });

    // Scripted global fetch: answers the /health pre-check "ok" and records every request —
    // the REAL cancelJob drives the DELETE through it, so method+path+header are the wire truth.
    const requests: { url: string; method: string; headers?: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
      });
      return { ok: true, status: init?.method === "DELETE" ? 204 : 200, json: async () => ({}) };
    }) as unknown as typeof fetch;

    // trainNerf: surface the job id (as the real client does right after submit), then "train"
    // until the panel's Cancel aborts the signal — the id must outlive the abort for the DELETE.
    nerfPkg.trainNerf.mockImplementationOnce(
      (_input, opts) =>
        new Promise((_resolve, reject) => {
          opts?.onJob?.("job-42");
          const abort = (): void => reject(new DOMException("aborted", "AbortError"));
          if (opts?.signal?.aborted) abort();
          else opts?.signal?.addEventListener("abort", abort);
        }),
    );

    render(<GenerationPanel />);
    const transforms = new File([JSON.stringify({ frames: [{ file_path: "v0.png" }] })], "transforms.json", {
      type: "application/json",
    });
    await selectFile("nerf-transforms-input", transforms);
    await selectFile("nerf-images-input", new File([new Uint8Array([1, 2, 3])], "v0.png", { type: "image/png" }));
    await waitForCaptureEnabled();

    await act(async () => {
      fireEvent.click(captureBtn());
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("nerf-cancel-btn"));
    });

    // Polling aborted → a clean user cancel: status says so and the error slot stays EMPTY
    // (a failed best-effort DELETE must never masquerade as a capture error).
    await waitFor(() => expect(screen.getByTestId("nerf-status").textContent).toBe("cancelled"));
    expect(screen.queryByTestId("nerf-error")).toBeNull();

    // …and the server-side job was cancelled too: DELETE /jobs/{id}, bearer-authed (SPEC-11 §5).
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE")).toBe(true));
    const del = requests.find((r) => r.method === "DELETE");
    expect(del?.url).toBe("http://localhost:8002/jobs/job-42");
    expect(del?.headers?.["Authorization"]).toBe("Bearer nerf-secret");
    expect(screen.queryByTestId("mesh-convert")).toBeNull(); // nothing persisted/opened
  });
});
