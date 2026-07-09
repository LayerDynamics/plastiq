// SPEC-6 R1.5 (T1.5): the reactive settings slice; R5.1 (T5.1): the per-project
// conversation slice — both over IndexedDB (fake-indexeddb here).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, it, expect } from "vitest";
import { useAiStore } from "./aiStore.js";
import { putConversation } from "./conversation.js";
import { EMPTY_SESSION_USAGE } from "./usage.js";
import type { PlanGraph } from "./planning.js";
import type { AiSettings } from "./settings.js";
import type { ChatMessage } from "./providers/types.js";

afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
  // reset the singleton store (settings + conversation + session-usage slices)
  useAiStore.setState({
    settings: null,
    loaded: false,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
    sessionUsage: EMPTY_SESSION_USAGE,
  });
});

const sample = (): AiSettings => ({
  providerKey: "ollama",
  providerId: "openai-compatible",
  model: "qwen2.5",
  baseURL: "http://localhost:11434/v1",
  apiKeys: {},
});

describe("R1.5 aiStore settings slice", () => {
  it("load on first run yields null settings but loaded=true", async () => {
    await useAiStore.getState().load();
    expect(useAiStore.getState().settings).toBeNull();
    expect(useAiStore.getState().loaded).toBe(true);
  });

  it("save persists and applies settings", async () => {
    await useAiStore.getState().save(sample());
    expect(useAiStore.getState().settings?.model).toBe("qwen2.5");
    // A fresh load (after reset) reads the persisted value back.
    useAiStore.setState({ settings: null, loaded: false });
    await useAiStore.getState().load();
    expect(useAiStore.getState().settings?.model).toBe("qwen2.5");
  });

  it("clear returns to first-run", async () => {
    await useAiStore.getState().save(sample());
    await useAiStore.getState().clear();
    expect(useAiStore.getState().settings).toBeNull();
  });
});

describe("6-L2 aiStore session-usage slice (cumulative across runs)", () => {
  it("starts empty", () => {
    expect(useAiStore.getState().sessionUsage).toEqual({
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      paidJobs: 0,
    });
  });

  it("recordRunUsage folds each run's snapshot into a cumulative session total (turns + tokens + paid)", () => {
    // Two runs — the readout must show the SUM, not reset each generation (the 6-L2 bug).
    useAiStore.getState().recordRunUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, paidJobs: 1 });
    useAiStore.getState().recordRunUsage({ inputTokens: 50, outputTokens: 10, totalTokens: 60, paidJobs: 0 });
    expect(useAiStore.getState().sessionUsage).toEqual({
      turns: 2,
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      paidJobs: 1,
    });
  });
});

describe("R5.1 aiStore conversation slice (per-project history)", () => {
  const userMsg = (text: string): ChatMessage => ({ role: "user", content: text });

  it("a conversation saves under the active project id and reloads on reopen", async () => {
    await useAiStore.getState().openConversation("proj-A");
    await useAiStore.getState().appendMessage(userMsg("make a 20mm cube"));
    await useAiStore.getState().appendTrace({ kind: "tool-call", name: "build_part", detail: "1 feature" });

    // Drop the in-memory copy, then reopen the same project — it must rehydrate.
    useAiStore.setState({ conversation: { messages: [], trace: [] }, conversationProjectId: null });
    await useAiStore.getState().openConversation("proj-A");

    const conv = useAiStore.getState().conversation;
    expect(conv.messages).toEqual([{ role: "user", content: "make a 20mm cube" }]);
    expect(conv.trace).toEqual([{ kind: "tool-call", name: "build_part", detail: "1 feature" }]);
  });

  it("switching projects shows the right history (isolated per id)", async () => {
    await useAiStore.getState().openConversation("A");
    await useAiStore.getState().appendMessage(userMsg("part A prompt"));
    await useAiStore.getState().openConversation("B");
    await useAiStore.getState().appendMessage(userMsg("part B prompt"));

    await useAiStore.getState().openConversation("A");
    expect(useAiStore.getState().conversation.messages).toEqual([{ role: "user", content: "part A prompt" }]);
    await useAiStore.getState().openConversation("B");
    expect(useAiStore.getState().conversation.messages).toEqual([{ role: "user", content: "part B prompt" }]);
  });

  it("opening an unseen project yields an empty conversation", async () => {
    await useAiStore.getState().openConversation("never-saved");
    expect(useAiStore.getState().conversation).toEqual({ messages: [], trace: [] });
  });

  it("deleting a project clears its persisted conversation and resets memory if active", async () => {
    await useAiStore.getState().openConversation("A");
    await useAiStore.getState().appendMessage(userMsg("hello"));

    await useAiStore.getState().deleteConversation("A");
    expect(useAiStore.getState().conversation).toEqual({ messages: [], trace: [] });
    expect(useAiStore.getState().conversationProjectId).toBeNull();

    // A reopen finds nothing persisted.
    await useAiStore.getState().openConversation("A");
    expect(useAiStore.getState().conversation.messages).toHaveLength(0);
  });

  it("an untitled conversation (no project id) is held in memory but not persisted", async () => {
    await useAiStore.getState().openConversation(null);
    await useAiStore.getState().appendMessage(userMsg("draft"));
    expect(useAiStore.getState().conversation.messages).toHaveLength(1); // in memory

    // Opening any real project must not surface the untitled draft.
    await useAiStore.getState().openConversation("X");
    expect(useAiStore.getState().conversation.messages).toHaveLength(0);
  });
});

describe("R5.1 trace — the 'plan' entry kind (9-M1)", () => {
  it("a 'plan' entry round-trips its FULL graph through IndexedDB (no truncation)", async () => {
    const plan: PlanGraph = {
      nodes: [
        { id: "chassis", part: "the main quadcopter chassis plate" },
        { id: "arm-fl", part: "front-left motor arm", parent: "chassis" },
        { id: "arm-fr", part: "front-right motor arm", parent: "chassis" },
        { id: "canopy", part: "aerodynamic canopy shell over the electronics bay", parent: "chassis" },
      ],
      relations: [
        { from: "arm-fl", to: "chassis", kind: "attached" },
        { from: "arm-fr", to: "chassis", kind: "attached" },
        { from: "canopy", to: "chassis", kind: "aligned" },
      ],
    };
    // Bigger than the panel's generic 200-char tool-line cut — the point of the kind.
    expect(JSON.stringify(plan).length).toBeGreaterThan(200);

    await useAiStore.getState().openConversation("proj-plan");
    await useAiStore.getState().appendTrace({ kind: "plan", name: "plan_part", detail: "plan accepted: 4 node(s), 3 relation(s); roots: chassis", plan });

    // Drop the in-memory copy, then reopen — the whole graph must rehydrate verbatim.
    useAiStore.setState({ conversation: { messages: [], trace: [] }, conversationProjectId: null });
    await useAiStore.getState().openConversation("proj-plan");
    expect(useAiStore.getState().conversation.trace).toEqual([
      { kind: "plan", name: "plan_part", detail: "plan accepted: 4 node(s), 3 relation(s); roots: chassis", plan },
    ]);
  });

  it("a trace persisted BEFORE the 'plan' kind existed still loads unchanged", async () => {
    // Simulate an old record on disk: only the original kinds, no `plan` field anywhere.
    await putConversation("legacy", {
      messages: [{ role: "user", content: "make a bracket" }],
      trace: [
        { kind: "tool-call", name: "build_part", detail: "1 feature" },
        { kind: "status", detail: "[answer · 2 steps]" },
      ],
    });
    await useAiStore.getState().openConversation("legacy");
    expect(useAiStore.getState().conversation).toEqual({
      messages: [{ role: "user", content: "make a bracket" }],
      trace: [
        { kind: "tool-call", name: "build_part", detail: "1 feature" },
        { kind: "status", detail: "[answer · 2 steps]" },
      ],
    });
  });
});
