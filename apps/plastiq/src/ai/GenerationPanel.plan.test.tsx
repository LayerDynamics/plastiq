// @vitest-environment jsdom
//
// 9-M1 — the committed decomposition plan is real UX. When the agent calls plan_part
// through the REAL runGeneration/agentRunner loop, the panel renders the FULL validated
// plan as a compact structured view (nodes indented under their parents, relations with
// kinds) — while the generic tool-call line cuts args at 200 chars — and the aiStore
// trace records the whole graph as its own typed entry. The chat provider is mocked at
// the registry seam (buildProvider) with a per-turn script, the ux-test precedent.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel, formatPlanGraph } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { PlanGraph } from "./planning.js";
import type { StreamEvent } from "./providers/types.js";

// Scripted fake chat provider behind the registry seam — one StreamEvent[] per turn,
// so the real agent loop plans on turn 1 and finalizes on turn 2.
const providerControl = vi.hoisted(() => ({
  scripts: [] as unknown[],
  calls: 0,
}));
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

const call = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool-call", call: { id, name, arguments: args } });
const done = (): StreamEvent => ({ type: "done", finishReason: "tool-calls" });

/** Serializes well past the 200-char cut of the generic `→ plan_part(…)` line, so the
 * later nodes/relations can ONLY appear in the transcript via the structured view. */
const BIG_PLAN: PlanGraph = {
  nodes: [
    { id: "chassis", part: "the main quadcopter chassis plate" },
    { id: "arm-fl", part: "front-left motor arm", parent: "chassis" },
    { id: "arm-fr", part: "front-right motor arm", parent: "chassis" },
    { id: "arm-rl", part: "rear-left motor arm", parent: "chassis" },
    { id: "arm-rr", part: "rear-right motor arm", parent: "chassis" },
    { id: "canopy", part: "aerodynamic canopy shell over the electronics bay", parent: "chassis" },
  ],
  relations: [
    { from: "arm-fl", to: "chassis", kind: "attached" },
    { from: "arm-fr", to: "chassis", kind: "attached" },
    { from: "arm-rl", to: "chassis", kind: "attached" },
    { from: "arm-rr", to: "chassis", kind: "attached" },
    { from: "canopy", to: "chassis", kind: "aligned" },
    { from: "arm-fl", to: "arm-rr", kind: "symmetric" },
  ],
};

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  providerControl.scripts = [
    [call("p1", "plan_part", BIG_PLAN), done()],
    [call("a1", "answer_user", { message: "planned the quadcopter" }), done()],
  ];
  providerControl.calls = 0;
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Type a prompt and send it (the chat path). */
const sendPrompt = async (text: string): Promise<void> => {
  fireEvent.change(screen.getByTestId("generation-prompt"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("generation-send"));
  });
};

describe("GenerationPanel — a committed plan renders fully, past the 200-char tool-line cut (9-M1)", () => {
  it("shows the whole hierarchy + relations and records the full graph in the trace", async () => {
    expect(JSON.stringify(BIG_PLAN).length).toBeGreaterThan(200); // the truncation premise
    render(<GenerationPanel />);
    await sendPrompt("build a quadcopter");

    // The tail of the plan serializes beyond char 200 — visible only via the plan view.
    await waitFor(() => {
      expect(screen.getByTestId("generation-transcript").textContent).toContain(
        "canopy — aerodynamic canopy shell over the electronics bay",
      );
    });
    const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
    // Structured hierarchy: root, then children (part names beside node ids).
    expect(transcript).toContain("◆ plan: 6 parts, 6 relations");
    expect(transcript).toContain("chassis — the main quadcopter chassis plate");
    expect(transcript).toContain("arm-rr — rear-right motor arm");
    // Relations carry their kinds — including ones far past the 200-char cut.
    expect(transcript).toContain("arm-fl —attached→ chassis");
    expect(transcript).toContain("canopy —aligned→ chassis");
    expect(transcript).toContain("arm-fl —symmetric→ arm-rr");

    // The per-project conversation trace holds the FULL plan as its own typed entry.
    const planEntries = useAiStore.getState().conversation.trace.filter((t) => t.kind === "plan");
    expect(planEntries).toHaveLength(1);
    expect(planEntries[0]!.plan).toEqual(BIG_PLAN);
    expect(planEntries[0]!.name).toBe("plan_part");
  });

  it("formatPlanGraph nests children under their parents and lists every relation", () => {
    const view = formatPlanGraph(BIG_PLAN);
    const lines = view.split("\n");
    expect(lines[0]).toBe("◆ plan: 6 parts, 6 relations");
    expect(lines[1]).toBe("  chassis — the main quadcopter chassis plate");
    // Children indent one level deeper than their parent.
    expect(lines[2]).toBe("    arm-fl — front-left motor arm");
    // All 6 relations render with their kinds (nothing dropped or truncated).
    expect(lines.filter((l) => l.includes("—attached→"))).toHaveLength(4);
    expect(view).toContain("  canopy —aligned→ chassis");
    expect(view).toContain("  arm-fl —symmetric→ arm-rr");
  });
});
