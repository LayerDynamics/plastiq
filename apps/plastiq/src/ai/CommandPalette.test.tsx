// @vitest-environment jsdom
//
// SPEC-6 FR-19 — CommandPalette component test (jsdom + RTL). Covers the palette's jobs:
// action search over the shared registry (filter + run), the quick-AI entry (wired to the
// same agent path as the panel), and FR-19 parity — live streaming text, the visible
// tool-call trace (error styling), image attach + route choice (parametric vision vs
// creative image→3D), and the paid-confirm gate. No network: the chat provider is
// scripted behind the registry seam (the ux/plan-test precedent) and the creative path's
// fal providers + GLB import are scripted module mocks, so the REAL runGeneration/
// agentRunner/createMesh wiring runs end to end in jsdom.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CommandPalette } from "./CommandPalette.js";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { EMPTY_SESSION_USAGE } from "./usage.js";
import type { ChatMessage, ChatStreamRequest, StreamEvent } from "./providers/types.js";
import type { MeshGenRequest } from "./meshgen/types.js";

// Scripted fake chat provider behind the registry seam — one script per turn (the
// plan-test idiom), plus a "wait" marker that parks the stream on a gate so tests can
// observe the LIVE transcript mid-run, and a controllable vision capability (FR-10b).
type ScriptStep = StreamEvent | "wait";
const providerControl = vi.hoisted(() => ({
  scripts: [] as unknown[],
  calls: 0,
  supportsVision: false,
  requests: [] as { system: string; messages: ChatMessage[] }[],
  release: null as null | (() => void),
}));
vi.mock("./providers/registry.js", () => ({
  // The palette threads the decision-21 key indirection into toProviderSettings; the
  // fake provider ignores keys, so a no-key resolver stands in for keyResolverFor.
  keyResolverFor: () => () => undefined,
  buildProvider: () => ({
    id: "openai-compatible" as const,
    model: "fake-model",
    supportsVision: providerControl.supportsVision,
    supportsTools: true,
    async *stream(req: ChatStreamRequest) {
      // Snapshot: the agent loop keeps mutating the same messages array after the turn.
      providerControl.requests.push({ system: req.system, messages: [...req.messages] });
      const scripts = providerControl.scripts as ScriptStep[][];
      const script = scripts[Math.min(providerControl.calls, scripts.length - 1)] ?? [];
      providerControl.calls += 1;
      for (const step of script) {
        if (step === "wait") {
          await new Promise<void>((resolve) => {
            providerControl.release = resolve;
          });
          continue;
        }
        yield step;
      }
    },
  }),
}));

// Scripted fal 3D-gen providers (the creative route's deps) — the REAL createMesh
// pipeline runs (confirm gate → resolveImage → submit → poll → fetch → validate →
// persist) with the network edges scripted: submit/poll here, the GLB download via a
// scripted global fetch, and the GLB validation via a mocked importGltf.
const meshControl = vi.hoisted(() => ({
  submits: [] as unknown[],
}));
// Three scripted fal image-gen models (6-L1-ui / task #47) whose `generate` records which model
// actually ran — the wire truth for "the palette's image-model pick reached the text2img3d call".
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
        label: "Tripo (fal)",
        supports: { text3d: false, img3d: true },
        submit: async (req: unknown) => {
          meshControl.submits.push(req);
          return { id: "job-1" };
        },
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
const text = (t: string): StreamEvent => ({ type: "text-delta", text: t });
const done = (finishReason: "stop" | "tool-calls" = "stop"): StreamEvent => ({ type: "done", finishReason });

const realFetch = globalThis.fetch;

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
    sessionUsage: EMPTY_SESSION_USAGE,
  });
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
  providerControl.scripts = [];
  providerControl.calls = 0;
  providerControl.supportsVision = false;
  providerControl.requests.length = 0;
  providerControl.release = null;
  meshControl.submits.length = 0;
  imageControl.generatedBy.length = 0;
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Attach an image file through the palette's attach input (bytes [1,2,3] → base64 "AQID"). */
const attachImage = async (name = "ref.png"): Promise<void> => {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  await act(async () => {
    fireEvent.change(screen.getByTestId("palette-attach-input"), { target: { files: [file] } });
  });
  await waitFor(() => expect(screen.getByTestId("palette-attach-name")).toBeTruthy());
};

/** Type a query and run the Ask-AI row. */
const runAi = async (prompt: string): Promise<void> => {
  if (prompt) fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: prompt } });
  await waitFor(() => expect(screen.getByTestId("palette-ai")).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByTestId("palette-ai"));
  });
};

describe("CommandPalette (FR-19)", () => {
  it("renders nothing when closed and a dialog when open", () => {
    const { rerender } = render(<CommandPalette open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("command-palette")).toBeNull();
    rerender(<CommandPalette open onClose={() => {}} />);
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    expect(screen.getByTestId("command-palette-input")).toBeTruthy();
  });

  it("filters the registry actions by query", async () => {
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "loft" } });
    await waitFor(() => expect(screen.getByTestId("palette-action-loft")).toBeTruthy());

    // A non-matching query leaves NO action rows (the Ask-AI row is separate, tested below).
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "zzz-nope" } });
    await waitFor(() => expect(screen.queryByTestId("palette-action-loft")).toBeNull());
    expect(screen.queryAllByTestId(/^palette-action-/)).toHaveLength(0);
  });

  it("reports 'No matching commands' when nothing matches and no AI row applies", async () => {
    // No provider configured → no Ask-AI row; a non-matching query → an empty list.
    useAiStore.setState({ settings: null });
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "zzz-nope" } });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-results").textContent).toContain("No matching commands"),
    );
  });

  it("running an action executes it (adds the feature) and closes the palette", async () => {
    const onClose = vi.fn();
    const before = useCadStore.getState().features.length;
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "loft" } });
    await waitFor(() => expect(screen.getByTestId("palette-action-loft")).toBeTruthy());
    fireEvent.click(screen.getByTestId("palette-action-loft"));
    expect(useCadStore.getState().features.length).toBe(before + 1); // loft really ran
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers an 'Ask AI' entry for a non-empty query when a provider is configured", async () => {
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByTestId("palette-ai")).toBeNull(); // empty query, no image → no AI row
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "a 20mm cube" } });
    await waitFor(() => expect(screen.getByTestId("palette-ai").textContent).toContain("Ask AI: a 20mm cube"));
  });

  it("the AI entry drives the real agent path (guards when the viewport isn't ready)", async () => {
    // No __plastiqBuild seam → buildTurnTools returns null → the wiring reports the guard,
    // proving the AI entry is really wired to the agent turn (not a dead button).
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "a cube" } });
    await waitFor(() => expect(screen.getByTestId("palette-ai")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-ai"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-status").textContent).toContain("isn’t ready"),
    );
  });

  it("Escape closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a compact session-usage readout from the shared aiStore total (6-L2)", () => {
    // A session that already spanned runs (from the panel or a prior palette run) surfaces here.
    useAiStore.setState({
      sessionUsage: { turns: 3, inputTokens: 200, outputTokens: 40, totalTokens: 240, paidJobs: 2 },
    });
    render(<CommandPalette open onClose={() => {}} />);
    const readout = screen.getByTestId("palette-usage-session");
    expect(readout.textContent).toContain("session 240 tok");
    expect(readout.textContent).toContain("3 runs");
    expect(readout.textContent).toContain("2 paid");
  });

  it("shows no session readout before any run", () => {
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByTestId("palette-usage-session")).toBeNull();
  });
});

describe("CommandPalette — FR-19 parity: streaming text + visible trace during a run", () => {
  beforeEach(() => {
    (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  });

  it("renders assistant deltas live WHILE the run is in flight (palette still open)", async () => {
    // The stream parks on the gate AFTER the deltas, so the run is provably mid-flight
    // when the transcript is asserted; releasing the gate lets it finish (and close).
    providerControl.scripts = [[text("Working "), text("on it…"), "wait", done("stop")]];
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    await runAi("a cube");

    await waitFor(() =>
      expect(screen.getByTestId("palette-transcript").textContent).toContain("Working on it…"),
    );
    expect(onClose).not.toHaveBeenCalled(); // mid-run: streaming text is visible, not post-hoc
    expect((screen.getByTestId("command-palette-input") as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      providerControl.release?.();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce()); // success dismisses
  });

  it("shows tool-call/result trace entries mid-run, with error results styled", async () => {
    // Turn 1: a build_part call with invalid args → the REAL handler returns a structured
    // error (isError). Turn 2 parks on the gate so the trace is asserted DURING the run.
    providerControl.scripts = [
      [call("t1", "build_part", {}), done("tool-calls")],
      ["wait", done("stop")],
    ];
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    await runAi("a cube");

    await waitFor(() => {
      const transcript = screen.getByTestId("palette-transcript").textContent ?? "";
      expect(transcript).toContain("→ build_part({})");
      expect(transcript).toContain("← build_part:");
    });
    expect(onClose).not.toHaveBeenCalled(); // the trace is visible while running

    // The failed tool result renders with error styling.
    const lineDivs = Array.from(screen.getByTestId("palette-transcript").querySelectorAll("div"));
    const resultLine = lineDivs.find((d) => d.textContent?.startsWith("← build_part"));
    expect(resultLine).toBeTruthy();
    expect(resultLine!.className).toContain("text-[#fb9]");
    const callLine = lineDivs.find((d) => d.textContent?.startsWith("→ build_part"));
    expect(callLine!.className).toContain("text-[#9cf]");

    // …and the same entries persist into the shared conversation trace (aiStore).
    await waitFor(() => {
      const trace = useAiStore.getState().conversation.trace;
      expect(trace.some((t) => t.kind === "tool-call" && t.name === "build_part")).toBe(true);
      expect(trace.some((t) => t.kind === "tool-result" && t.name === "build_part" && t.isError)).toBe(true);
    });

    await act(async () => {
      providerControl.release?.();
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

describe("CommandPalette — FR-19 parity: image attach + route choice (FR-10a/FR-10b)", () => {
  beforeEach(() => {
    (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  });

  it("route=creative drives the direct create_mesh path (paid gate → scripted fal → persist → open)", async () => {
    // Stub persistence (the real methods need the sql.js store, unavailable in jsdom);
    // record what gets opened so success is proven by behavior, not a mock call count.
    const opened: string[] = [];
    useProjectsStore.setState({
      createMeshProject: async () => "mesh-1",
      open: async (id: string) => {
        opened.push(id);
      },
    });
    // The GLB download goes through global fetch; script it.
    globalThis.fetch = (async () => ({
      arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
    })) as unknown as typeof fetch;

    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    await attachImage("dragon.png");
    fireEvent.click(screen.getByTestId("palette-route-creative"));
    // The per-job 3D provider picker appears for the creative route (img3d-capable only).
    const picker = screen.getByTestId("palette-mesh-provider") as HTMLSelectElement;
    expect(picker.value).toBe("fal:tripo");

    await runAi("a dragon");

    // The paid-job confirm gate fires BEFORE any billable call (FR-18a) — approve it.
    await waitFor(() => expect(screen.getByTestId("paid-confirm")).toBeTruthy());
    expect(meshControl.submits).toHaveLength(0); // gated: nothing submitted yet
    await act(async () => {
      fireEvent.click(screen.getByTestId("paid-confirm-yes"));
    });

    // The attached image (bytes [1,2,3] → "AQID") reached the 3D provider, the mesh was
    // persisted and opened, and the palette dismissed. The LLM was never involved.
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(meshControl.submits).toHaveLength(1);
    expect((meshControl.submits[0] as MeshGenRequest).image?.data).toBe("AQID");
    expect(opened).toEqual(["mesh-1"]);
    expect(providerControl.requests).toHaveLength(0);
  });

  it("declining the paid gate cancels the creative run and keeps the palette open", async () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    await attachImage();
    fireEvent.click(screen.getByTestId("palette-route-creative"));
    await runAi("a dragon");

    await waitFor(() => expect(screen.getByTestId("paid-confirm")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("paid-confirm-no"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("palette-transcript").textContent).toContain("was not confirmed"),
    );
    expect(meshControl.submits).toHaveLength(0); // nothing billable ran
    expect(onClose).not.toHaveBeenCalled(); // not a success → the palette stays open
  });

  it("route=parametric on a vision model feeds the provider the image part (FR-10a)", async () => {
    providerControl.supportsVision = true;
    providerControl.scripts = [[text("Nice part."), done("stop")]];
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    await attachImage("ref.png");
    // Vision-capable → parametric stays the default and is enabled.
    expect((screen.getByTestId("palette-route-parametric") as HTMLButtonElement).disabled).toBe(false);

    await runAi("model this");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    // The user turn the provider received is content parts: the text + the image (AQID).
    expect(providerControl.requests).toHaveLength(1);
    const messages = providerControl.requests[0]!.messages;
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toEqual([
      { type: "text", text: "model this" },
      { type: "image", mediaType: "image/png", data: "AQID" },
    ]);
  });

  it("a non-vision model DISABLES the parametric route with guidance and defaults to creative", async () => {
    // supportsVision=false (the default fake) — the visionRoute decision disables the
    // parametric route with guidance instead of silently dropping the image (FR-10b).
    render(<CommandPalette open onClose={() => {}} />);
    await attachImage();

    const parametricBtn = screen.getByTestId("palette-route-parametric") as HTMLButtonElement;
    expect(parametricBtn.disabled).toBe(true);
    expect(screen.getByTestId("palette-route-guidance").textContent).toContain("can’t see images");
    // The attachment auto-routes to the path that can run: creative image→3D.
    expect(screen.getByTestId("palette-mesh-provider")).toBeTruthy();
  });
});

describe("CommandPalette — image-gen provider selector (6-L1-ui / task #47)", () => {
  beforeEach(() => {
    (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  });

  it("renders the image-model select listing the fal image models, defaulting to flux-schnell", () => {
    render(<CommandPalette open onClose={() => {}} />);
    const select = screen.getByTestId("palette-image-gen-provider") as HTMLSelectElement;
    const opts = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual(["fal:flux-schnell", "fal:flux-dev", "fal:fast-sdxl"]);
    expect(select.value).toBe("fal:flux-schnell"); // DEFAULT_IMAGE_PROVIDER_ID
  });

  it("the CHOSEN image model reaches the text2img3d image-gen call (proves it's not a dead control)", async () => {
    // Stub persistence (the real methods need the sql.js store, unavailable in jsdom).
    useProjectsStore.setState({
      createMeshProject: async () => "mesh-1",
      open: async () => {},
    });
    // The generated GLB is downloaded via global fetch; script it (importGltf is mocked).
    globalThis.fetch = (async () => ({
      arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer,
    })) as unknown as typeof fetch;
    // The LLM emits a create_mesh(text2img3d) call (turn 1); turn 2 is an empty terminating
    // turn. done() defaults to "stop" in THIS file, so the tool-calls turn is spelled out.
    providerControl.scripts = [
      [
        call("m1", "create_mesh", { mode: "text2img3d", prompt: "a dragon", providerId: "fal:tripo" }),
        done("tool-calls"),
      ],
      [done("stop")],
    ];

    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    // Pick a NON-default image model BEFORE running (the confirm modal replaces the select in
    // the DOM), so a pass proves the override ran — not the flux-schnell default.
    fireEvent.change(screen.getByTestId("palette-image-gen-provider"), { target: { value: "fal:flux-dev" } });
    await runAi("a dragon");

    // The paid-job gate fires before any billable call (FR-18a) — approve it.
    await waitFor(() => expect(screen.getByTestId("paid-confirm")).toBeTruthy());
    expect(imageControl.generatedBy).toHaveLength(0); // gated: image-gen hasn't run yet
    await act(async () => {
      fireEvent.click(screen.getByTestId("paid-confirm-yes"));
    });

    // The text→image stage ran on the SELECTED model, threaded through turnDeps.settings →
    // buildCreateMeshDeps → buildMeshGenDeps — proving the palette's pick is a live control.
    await waitFor(() => expect(imageControl.generatedBy).toEqual(["fal:flux-dev"]));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce()); // success dismisses
  });
});
