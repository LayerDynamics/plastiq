// @vitest-environment jsdom
//
// SPEC-6 6-L1-ui — per-job image-gen provider selector for AI text→3D. The image model
// select (create_mesh text2img3d only) must be a LIVE control, not decoration: the id the
// user picks has to reach the text→image stage. This drives the REAL agent loop (scripted
// chat provider emits a create_mesh(text2img3d) tool-call) with scripted fal providers whose
// image `generate` records which model ran — so the assertion is on the actual image-gen call,
// not a prop. The chat provider + fal providers are mocked at their seams (the palette/plan
// test precedent); createMesh/agentRunner/buildMeshGenDeps run for real end to end.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { EMPTY_SESSION_USAGE } from "./usage.js";
import type { StreamEvent } from "./providers/types.js";

// Scripted chat provider behind the registry seam — one StreamEvent[] per turn.
const providerControl = vi.hoisted(() => ({ scripts: [] as unknown[], calls: 0 }));
vi.mock("./providers/registry.js", () => ({
  keyResolverFor: () => () => undefined,
  buildProvider: () => ({
    id: "openai-compatible" as const,
    model: "fake-model",
    supportsVision: false,
    supportsTools: true,
    async *stream() {
      const scripts = providerControl.scripts as StreamEvent[][];
      const script = scripts[Math.min(providerControl.calls, scripts.length - 1)] ?? [];
      providerControl.calls += 1;
      for (const ev of script) yield ev;
    },
  }),
}));

// Scripted fal providers: a text+image 3D provider (tripo) and THREE image-gen models whose
// `generate` records which model actually ran — the wire truth for "the pick reached the call".
const imageControl = vi.hoisted(() => ({ generatedBy: [] as string[] }));
vi.mock("./meshgen/fal.js", () => {
  const mkImage = (id: string, label: string) => ({
    id,
    label,
    generate: async () => {
      imageControl.generatedBy.push(id);
      return { mediaType: "image/png", data: "IMG" };
    },
  });
  return {
    falMeshProviders: () => [
      {
        id: "fal:tripo",
        label: "Tripo",
        supports: { text3d: true, img3d: true },
        submit: async () => ({ id: "job-1" }),
        poll: async () => ({ state: "succeeded" as const, glbUrl: "https://fake.local/out.glb" }),
      },
    ],
    // Order matters: flux-schnell is the catalog default (DEFAULT_IMAGE_PROVIDER_ID).
    falImageProviders: () => [
      mkImage("fal:flux-schnell", "FLUX schnell"),
      mkImage("fal:flux-dev", "FLUX dev"),
      mkImage("fal:fast-sdxl", "Fast SDXL"),
    ],
    meshProviderRegistry: (providers: { id: string }[]) => (id: string) => providers.find((p) => p.id === id),
  };
});
vi.mock("../mesh/importGltf.js", () => ({ importGltf: async () => ({}) }));

const call = (id: string, name: string, args: unknown): StreamEvent => ({
  type: "tool-call",
  call: { id, name, arguments: args },
});
const done = (finishReason: "stop" | "tool-calls" = "tool-calls"): StreamEvent => ({ type: "done", finishReason });

const realFetch = globalThis.fetch;

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
    sessionUsage: EMPTY_SESSION_USAGE,
  });
  useProjectsStore.setState({
    activeMeshDoc: null,
    createMeshProject: async () => "mesh-1",
    open: async () => {},
  });
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  // The generated GLB is downloaded via global fetch; script it (importGltf is mocked).
  globalThis.fetch = (async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })) as unknown as typeof fetch;
  providerControl.scripts = [
    [call("m1", "create_mesh", { mode: "text2img3d", prompt: "a dragon", providerId: "fal:tripo" }), done()],
    [call("a1", "answer_user", { message: "generated a dragon" }), done()],
  ];
  providerControl.calls = 0;
  imageControl.generatedBy = [];
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

describe("GenerationPanel — image-gen provider selector (6-L1-ui)", () => {
  it("renders the image-model select listing the fal image models, defaulting to flux-schnell", () => {
    render(<GenerationPanel />);
    const select = screen.getByTestId("image-gen-provider") as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual(["fal:flux-schnell", "fal:flux-dev", "fal:fast-sdxl"]);
    expect(select.value).toBe("fal:flux-schnell"); // DEFAULT_IMAGE_PROVIDER_ID
  });

  it("the CHOSEN image model reaches the text2img3d image-gen call (proves it's not a dead control)", async () => {
    render(<GenerationPanel />);
    // Pick a NON-default image model, so a pass proves the override — not the default — ran.
    fireEvent.change(screen.getByTestId("image-gen-provider"), { target: { value: "fal:flux-dev" } });
    fireEvent.change(screen.getByTestId("generation-prompt"), { target: { value: "a dragon" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("generation-send"));
    });

    // The paid-job gate fires before any billable call (FR-18a) — approve it.
    await waitFor(() => expect(screen.getByTestId("paid-confirm")).toBeTruthy());
    expect(imageControl.generatedBy).toHaveLength(0); // gated: image-gen hasn't run yet
    await act(async () => {
      fireEvent.click(screen.getByTestId("paid-confirm-yes"));
    });

    // The text→image stage ran on the SELECTED model, threaded through turnDeps.settings.
    await waitFor(() => expect(imageControl.generatedBy).toEqual(["fal:flux-dev"]));
  });
});
