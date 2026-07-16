// @vitest-environment jsdom
//
// SPEC-11 §5 (11-L6) — the NerfCaptureSection training knobs: method (NeuS/NeRF), iters,
// marching-cubes grid, position encoding, and fine PDF samples, driven end-to-end through the
// panel with REAL file inputs (FileReader) and the REAL @plastiq/nerf submit→poll client over a
// scripted global fetch — so the assertions are on the actual /train wire JSON, not a mock:
//  1. untouched knobs submit the pre-knob body EXACTLY (no method/iters/grid_res/encoding/
//     importance_samples keys — the client's omit-when-unset serialization);
//  2. every moved knob lands in the submit body in wire (snake_case) form;
//  3. the encoding select is a NeRF-only affordance: disabled AND reset under NeuS (the server
//     422s `hashgrid`+`neus` — the panel mirrors that constraint instead of tripping it).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

const realFetch = globalThis.fetch;

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
  globalThis.fetch = realFetch;
});

/** Script the full nerf-service conversation (health → /train → status → result), completing on
 * the FIRST poll (no timers), and record the /train submit body — the wire truth under test. */
function installScriptedFetch(): { spy: ReturnType<typeof vi.fn>; submitBody: () => Record<string, unknown> | undefined } {
  let body: Record<string, unknown> | undefined;
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    if (u.endsWith("/train")) {
      body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
      return { ok: true, status: 200, json: async () => ({ id: "job-1", state: "queued" }) };
    }
    if (u.endsWith("/status")) return { ok: true, status: 200, json: async () => ({ id: "job-1", state: "completed" }) };
    if (u.endsWith("/result")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ glb_base64: "R0xCdGVzdA==", vertices: 8, faces: 12, psnr: 21, method: "neus", iters: 500 }),
      };
    }
    throw new Error(`unexpected url ${u}`);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, submitBody: () => body };
}

/** Replace the two projectsStore actions the section drives (the real ones need the sql.js store,
 * unavailable in jsdom); `opened()` doubles as the capture-completed signal to await on. */
function stubProjectsStore(): { opened: () => string | null } {
  let openedId: string | null = null;
  useProjectsStore.setState({
    createMeshProject: async () => "mesh-7",
    open: async (id: string) => {
      openedId = id;
    },
  });
  return { opened: () => openedId };
}

/** Upload a 1-frame transforms.json + its single image through the REAL file inputs and wait for
 * the async FileReader reads to land (the Capture button enables only once both do). */
async function uploadPosedSet(): Promise<void> {
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
}

/** Click Capture and wait for the flow to finish (persist → open). */
async function runCapture(store: { opened: () => string | null }): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("nerf-capture-btn"));
  });
  await waitFor(() => expect(store.opened()).toBe("mesh-7"));
}

describe("NerfCaptureSection — untouched knobs preserve the pre-knob submit body (11-L6)", () => {
  it("submits transforms_json + images ONLY — no knob keys ride along at their defaults", async () => {
    const { submitBody } = installScriptedFetch();
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadPosedSet();

    // The knobs render on their server defaults: NeuS active, encoding a NeRF-only affordance.
    expect(screen.getByTestId("nerf-method-neus").className).toContain("bg-[#14253a]");
    expect((screen.getByTestId("nerf-iters") as HTMLInputElement).value).toBe("500");
    expect((screen.getByTestId("nerf-grid-res") as HTMLSelectElement).value).toBe("64");
    expect((screen.getByTestId("nerf-encoding") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("nerf-importance") as HTMLInputElement).value).toBe("0");

    await runCapture(store);

    const body = submitBody();
    expect(body?.transforms_json).toBe(JSON.stringify({ frames: [{ file_path: "v0.png" }] }));
    expect(body?.images).toHaveLength(1);
    // The client omits unset fields — the untouched panel's wire body carries NO knob keys.
    for (const key of ["method", "iters", "grid_res", "encoding", "importance_samples"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});

describe("NerfCaptureSection — every moved knob reaches the /train wire body (11-L6)", () => {
  it("method/iters/grid_res/encoding/importance_samples land in snake_case wire form", async () => {
    const { submitBody } = installScriptedFetch();
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadPosedSet();

    fireEvent.click(screen.getByTestId("nerf-method-nerf"));
    fireEvent.change(screen.getByTestId("nerf-iters"), { target: { value: "1000" } });
    fireEvent.change(screen.getByTestId("nerf-grid-res"), { target: { value: "128" } });
    // NeRF active → the encoding select is enabled and the hash grid selectable.
    const enc = screen.getByTestId("nerf-encoding") as HTMLSelectElement;
    expect(enc.disabled).toBe(false);
    fireEvent.change(enc, { target: { value: "hashgrid" } });
    fireEvent.change(screen.getByTestId("nerf-importance"), { target: { value: "64" } });

    await runCapture(store);

    const body = submitBody();
    expect(body?.method).toBe("nerf");
    expect(body?.iters).toBe(1000);
    expect(body?.grid_res).toBe(128);
    expect(body?.encoding).toBe("hashgrid");
    expect(body?.importance_samples).toBe(64);
  });
});

describe("NerfCaptureSection — filename-based image↔frame pairing (11-M3)", () => {
  /** Upload a 2-frame transforms.json + its images (in the given selection order), then wait for
   * both async FileReader reads to land (the Capture button enables only once they do). */
  const uploadTwo = async (transformsJson: string, images: File[]): Promise<void> => {
    const transforms = new File([transformsJson], "transforms.json", { type: "application/json" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-transforms-input"), { target: { files: [transforms] } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-images-input"), { target: { files: images } });
    });
    await waitFor(() => expect((screen.getByTestId("nerf-capture-btn") as HTMLButtonElement).disabled).toBe(false));
  };

  it("reorders picker-order images into FRAME order before submit (the misassignment bug)", async () => {
    const { submitBody } = installScriptedFetch();
    const store = stubProjectsStore();
    render(<GenerationPanel />);

    // Frames want v0 then v1; hand the picker the images REVERSED (v1, v0). fileToBase64:
    // bytes[0] → "AA==", bytes[1] → "AQ==".
    await uploadTwo(JSON.stringify({ frames: [{ file_path: "v0.png" }, { file_path: "v1.png" }] }), [
      new File([new Uint8Array([1])], "v1.png", { type: "image/png" }),
      new File([new Uint8Array([0])], "v0.png", { type: "image/png" }),
    ]);

    await runCapture(store);

    // Submitted in FRAME order (v0="AA==" then v1="AQ=="), not the reversed picker order.
    expect(submitBody()?.images).toEqual(["AA==", "AQ=="]);
    expect(screen.queryByTestId("nerf-pairing-note")).toBeNull(); // matched by filename → no note
  });

  it("blocks capture with a clear error when a frame filename has no matching image", async () => {
    installScriptedFetch();
    stubProjectsStore();
    render(<GenerationPanel />);

    await uploadTwo(JSON.stringify({ frames: [{ file_path: "v0.png" }, { file_path: "v1.png" }] }), [
      new File([new Uint8Array([0])], "v0.png", { type: "image/png" }),
      new File([new Uint8Array([9])], "v9.png", { type: "image/png" }), // no frame "v9"
    ]);

    await act(async () => {
      fireEvent.click(screen.getByTestId("nerf-capture-btn"));
    });

    await waitFor(() => expect(screen.getByTestId("nerf-error").textContent).toContain("v1.png"));
    expect(screen.queryByTestId("mesh-convert")).toBeNull(); // nothing submitted/opened
  });

  it("falls back to positional pairing WITH a visible note when transforms has no file paths", async () => {
    const { submitBody } = installScriptedFetch();
    const store = stubProjectsStore();
    render(<GenerationPanel />);

    await uploadTwo(JSON.stringify({ frames: [{}, {}] }), [
      new File([new Uint8Array([0])], "a.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "b.png", { type: "image/png" }),
    ]);

    await runCapture(store);

    // Positional pairing preserved (selection order) and the user is told so via a visible note.
    expect(submitBody()?.images).toEqual(["AA==", "AQ=="]);
    expect(screen.getByTestId("nerf-pairing-note").textContent).toContain("selection order");
  });
});

describe("NerfCaptureSection — hashgrid is NeRF-only: disabled AND reset under NeuS (11-L6)", () => {
  it("switching back to neus disables the encoding select, resets it, and keeps it off the wire", async () => {
    const { submitBody } = installScriptedFetch();
    const store = stubProjectsStore();
    render(<GenerationPanel />);
    await uploadPosedSet();

    // Pick the NeRF-only hash grid…
    fireEvent.click(screen.getByTestId("nerf-method-nerf"));
    fireEvent.change(screen.getByTestId("nerf-encoding"), { target: { value: "hashgrid" } });
    expect((screen.getByTestId("nerf-encoding") as HTMLSelectElement).value).toBe("hashgrid");

    // …then switch back to NeuS: the SDF trunk has no position encoding (the server 422s the
    // combo), so the select disables AND resets — no stale hashgrid can ride along.
    fireEvent.click(screen.getByTestId("nerf-method-neus"));
    const enc = screen.getByTestId("nerf-encoding") as HTMLSelectElement;
    expect(enc.disabled).toBe(true);
    expect(enc.value).toBe("frequency");

    await runCapture(store);

    const body = submitBody();
    // Back on the defaults → both keys are omitted (method AND the reset encoding).
    expect(body).not.toHaveProperty("encoding");
    expect(body).not.toHaveProperty("method");
  });
});
