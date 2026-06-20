// SPEC-6 R1.5 (T1.5): the reactive settings slice; R5.1 (T5.1): the per-project
// conversation slice — both over IndexedDB (fake-indexeddb here).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, it, expect } from "vitest";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";
import type { ChatMessage } from "./providers/types.js";

afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
  // reset the singleton store (settings + conversation slices)
  useAiStore.setState({
    settings: null,
    loaded: false,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
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
