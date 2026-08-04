import { beforeEach, describe, expect, it } from "vitest";

import { useAiStore } from "../ai/aiStore.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { useCadStore } from "../store/store.js";
import { resolveContextTarget, type ContextTarget } from "../three/contextmenu/contextSelection.js";
import {
  completeConsoleInput,
  executeConsoleInput,
  parseConsoleNumber,
  splitConsoleStatements,
  tokenizeConsoleStatement,
} from "./commandConsole.js";

function context(): ContextTarget {
  const cad = useCadStore.getState();
  return resolveContextTarget({
    cad: {
      picks: cad.picks,
      selMode: cad.selMode,
      selectionRefs: cad.selectionRefs,
      features: cad.features,
      selectedFeatureId: cad.selectedFeatureId,
      mateMode: cad.mateMode,
      matePicks: cad.matePicks,
      simulating: cad.simulating,
      simPaused: cad.simPaused,
      section: cad.section,
      measuring: cad.measuring,
      explodeFactor: cad.explodeFactor,
      gizmoMode: cad.gizmoMode,
    },
    sketch: { active: false, selection: [], solverReady: true, model: null },
    hit: null,
    worldPoint: [0, 0, 0],
  });
}

beforeEach(() => {
  useCadStore.setState({
    features: [],
    params: {},
    nextSeq: 1,
    selectedFeatureId: null,
    picks: [],
    selMode: "face",
    status: "ready",
    workspace: "design",
    past: [],
    future: [],
    featureErrors: {},
    featureWarnings: {},
    selectionRefs: { faces: {}, edges: {}, vertices: {} },
    massProps: null,
  });
  useAiStore.setState({ settings: null });
});

describe("Text Commands parser", () => {
  it("supports quoted arguments, escaped text, and semicolon command sequences", () => {
    expect(tokenizeConsoleStatement('feature rename f1 "Top plate"')).toEqual([
      "feature",
      "rename",
      "f1",
      "Top plate",
    ]);
    expect(tokenizeConsoleStatement("feature rename f1 Top\\ plate")).toEqual([
      "feature",
      "rename",
      "f1",
      "Top plate",
    ]);
    expect(splitConsoleStatements('status; feature rename f1 "A;B"; document')).toEqual([
      "status",
      'feature rename f1 "A;B"',
      "document",
    ]);
  });

  it("accepts CAD units and converts them to SI", () => {
    expect(parseConsoleNumber("20mm")).toBeCloseTo(0.02);
    expect(parseConsoleNumber("2in")).toBeCloseTo(0.0508);
    expect(parseConsoleNumber("90deg")).toBeCloseTo(Math.PI / 2);
    expect(() => parseConsoleNumber("twenty")).toThrow(/invalid number/);
  });
});

describe("Text Commands runtime", () => {
  it("executes registry actions through their live context", async () => {
    const result = await executeConsoleInput("CYL", context());
    expect(result.messages.at(-1)?.text).toMatch(/Ran Cylinder \(cylinder\)/);
    expect(useCadStore.getState().features).toHaveLength(1);
    expect(useCadStore.getState().features[0]?.type).toBe("cylinder");
  });

  it("reports context-disabled actions instead of silently no-oping", async () => {
    const result = await executeConsoleInput("run loft", context());
    expect(result.messages.at(-1)).toEqual({
      kind: "error",
      text: 'action "loft" is currently disabled',
    });
    expect(useCadStore.getState().features).toHaveLength(0);
  });

  it("authors parameters with units and preserves undo history", async () => {
    const result = await executeConsoleInput(
      "param set width 20mm; parameter get width",
      context(),
    );
    expect(useCadStore.getState().params.width).toBeCloseTo(0.02);
    expect(useCadStore.getState().past).toHaveLength(1);
    expect(result.messages.at(-1)?.text).toBe("width = 0.02");
  });

  it("renames, selects, and suppresses real feature timeline entries", async () => {
    const id = useCadStore.getState().addFeature({ type: "box", params: { dx: 0.01 } });
    await executeConsoleInput(`feature rename ${id} "Top plate"`, context());
    await executeConsoleInput(`feature suppress ${id}`, context());
    await executeConsoleInput(`feature select ${id}`, context());
    const feature = useCadStore.getState().features[0]!;
    expect(feature.name).toBe("Top plate");
    expect(feature.suppressed).toBe(true);
    expect(useCadStore.getState().selectedFeatureId).toBe(id);
  });

  it("switches workspaces through the same sketch-exit invariant as the visible switcher", async () => {
    useSketchStore.setState({ active: true });
    await executeConsoleInput("workspace assemble", context());
    expect(useSketchStore.getState().active).toBe(false);
    expect(useCadStore.getState().workspace).toBe("assemble");
  });

  it("probes every configured service endpoint through the health boundary", async () => {
    useAiStore.setState({
      settings: {
        providerKey: "ollama",
        providerId: "openai-compatible",
        model: "qwen2.5",
        apiKeys: {},
        reconstructBaseURL: "http://reconstruct.local",
      },
    });
    const calls: string[] = [];
    const result = await executeConsoleInput("services", context(), {
      checkHealth: async (url) => {
        calls.push(url);
        return url === "http://reconstruct.local";
      },
    });
    expect(calls).toHaveLength(5);
    expect(
      result.messages.some(
        (message) =>
          message.text.includes("● online") && message.text.includes("reconstruct.local"),
      ),
    ).toBe(true);
    expect(result.messages.filter((message) => message.text.includes("○ offline"))).toHaveLength(4);
  });

  it("supports help/history, clear, unique abbreviations, and completion", async () => {
    const help = await executeConsoleInput("he status", context(), {
      history: ["document", "status"],
    });
    expect(help.messages.at(-1)?.text).toMatch(/^status —/);
    const history = await executeConsoleInput("hist 1", context(), {
      history: ["document", "status"],
    });
    expect(history.messages.at(-1)?.text).toBe("1  status");
    const cleared = await executeConsoleInput("document; clear; status", context());
    expect(cleared.clear).toBe(true);
    expect(cleared.messages.some((message) => message.text.includes("No feature errors"))).toBe(
      true,
    );
    expect(completeConsoleInput("ser", context())).toContain("services");
  });
});
