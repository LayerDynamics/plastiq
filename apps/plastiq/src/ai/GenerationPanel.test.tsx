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
import type { MeshDoc } from "../store/types.js";

// The NeRF capture flow trains server-side; mock the package client so the test drives the real
// component (file inputs → captureFromPhotos → persist → open) without a network/server.
vi.mock("@plastiq/nerf", () => ({
  trainNerf: vi.fn(async () => ({
    glb: "R0xCdGVzdA==",
    report: { method: "neus", iters: 100, psnr: 20, vertices: 10, faces: 20 },
  })),
}));

beforeEach(() => {
  // A provider is configured (past first-run) and no mesh doc is open → the main panel.
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
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
});
