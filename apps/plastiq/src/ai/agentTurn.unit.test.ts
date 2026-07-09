// @vitest-environment jsdom
//
// SPEC-6 R2.4 / 9-M1 — buildTurnTools wires plan_part's onPlan into the aiStore:
// when the agent commits a validated decomposition plan through the REAL runAgent
// loop, the FULL graph lands in the per-project conversation trace as its own typed
// entry (kind "plan") — untruncated, unlike the generic 200-char tool lines — and
// the caller's live-UI hook (TurnToolsDeps.onPlan) is forwarded the same plan.
// jsdom + fake-indexeddb because agentTurn pulls in the projects/AI stores.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTurnTools, type TurnToolsDeps } from "./agentTurn.js";
import { runAgent } from "./agentRunner.js";
import { useAiStore } from "./aiStore.js";
import { summarizePlan, type PlanGraph } from "./planning.js";
import { ANSWER_USER } from "./tools/toolDefs.js";
import type { AiSettings } from "./settings.js";
import type { ChatProvider, StreamEvent } from "./providers/types.js";

/** A ChatProvider that yields a scripted StreamEvent[] per stream() call (the
 * toolDefs.unit.test.ts pattern — drives the real agent loop, no network). */
class ScriptedProvider implements ChatProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "fake";
  readonly supportsVision = false;
  readonly supportsTools = true;
  private i = 0;
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.i, this.scripts.length - 1)] ?? [];
    this.i += 1;
    for (const ev of script) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool-call", call: { id, name, arguments: args } });
const done = (): StreamEvent => ({ type: "done", finishReason: "tool-calls" });

const settings: AiSettings = {
  providerKey: "ollama",
  providerId: "openai-compatible",
  model: "qwen2.5",
  baseURL: "http://localhost:11434/v1",
  apiKeys: {},
};

function turnDeps(over: Partial<TurnToolsDeps> = {}): TurnToolsDeps {
  return { settings, confirm: async () => false, recordPaidJob: () => {}, ...over };
}

/** Long enough that the panel's generic tool-call line (args JSON sliced to 200
 * chars) would cut it mid-graph — the trace entry must hold it whole. */
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
    settings,
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  // The viewport's published build seam — buildTurnTools returns null without it.
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
});

afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

describe("buildTurnTools — a committed plan reaches the conversation trace intact (9-M1)", () => {
  it("runAgent → plan_part records the FULL plan as a typed 'plan' trace entry", async () => {
    expect(JSON.stringify(BIG_PLAN).length).toBeGreaterThan(200); // beyond the generic cut
    const tools = buildTurnTools(turnDeps());
    expect(tools).not.toBeNull();

    const provider = new ScriptedProvider([
      [call("p1", "plan_part", BIG_PLAN), done()],
      [call("a1", ANSWER_USER, { message: "planned" }), done()],
    ]);
    const res = await runAgent({
      provider,
      system: "s",
      messages: [{ role: "user", content: "plan a quadcopter" }],
      tools: tools!,
    });
    expect(res.finish).toBe("answer");

    const planEntries = useAiStore.getState().conversation.trace.filter((t) => t.kind === "plan");
    expect(planEntries).toHaveLength(1);
    expect(planEntries[0]).toEqual({
      kind: "plan",
      name: "plan_part",
      detail: summarizePlan(BIG_PLAN),
      plan: BIG_PLAN, // the whole validated graph — never truncated
    });
  });

  it("forwards the plan to the caller's live-UI hook (TurnToolsDeps.onPlan) too", async () => {
    const onPlan = vi.fn();
    const tools = buildTurnTools(turnDeps({ onPlan }));
    const provider = new ScriptedProvider([
      [call("p1", "plan_part", BIG_PLAN), done()],
      [call("a1", ANSWER_USER, { message: "planned" }), done()],
    ]);
    await runAgent({ provider, system: "s", messages: [{ role: "user", content: "x" }], tools: tools! });
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onPlan).toHaveBeenCalledWith(BIG_PLAN);
  });

  it("a rejected plan records NO trace entry (the model gets the error to fix instead)", async () => {
    const onPlan = vi.fn();
    const tools = buildTurnTools(turnDeps({ onPlan }));
    const provider = new ScriptedProvider([
      [call("p1", "plan_part", { nodes: [{ id: "a", part: "a", parent: "ghost" }] }), done()],
      [call("a1", ANSWER_USER, { message: "gave up" }), done()],
    ]);
    await runAgent({ provider, system: "s", messages: [{ role: "user", content: "x" }], tools: tools! });
    expect(onPlan).not.toHaveBeenCalled();
    expect(useAiStore.getState().conversation.trace.filter((t) => t.kind === "plan")).toHaveLength(0);
  });
});
