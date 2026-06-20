// SPEC-6 R1.5 (T1.5): the reactive settings slice over the IndexedDB store.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, it, expect } from "vitest";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";

afterEach(() => {
  globalThis.indexedDB = new IDBFactory();
  useAiStore.setState({ settings: null, loaded: false }); // reset the singleton store
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
