// SPEC-6 R1.5 (T1.5): settings persistence (real IndexedDB via fake-indexeddb),
// first-run state, and the proxy-ready key indirection.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, it, expect } from "vitest";
import {
  loadSettings,
  saveSettings,
  clearSettings,
  isFirstRun,
  proxyKeyResolver,
  toProviderSettings,
  type AiSettings,
} from "./settings.js";

afterEach(() => {
  globalThis.indexedDB = new IDBFactory(); // pristine DB per case (no cross-leak)
});

const sample = (): AiSettings => ({
  providerKey: "anthropic",
  providerId: "anthropic",
  model: "claude-opus-4-8",
  apiKeys: { anthropic: "sk-test" },
});

describe("R1.5 settings persistence", () => {
  it("first run: nothing persisted", async () => {
    expect(await loadSettings()).toBeNull();
    expect(isFirstRun(null)).toBe(true);
  });

  it("round-trips settings through IndexedDB", async () => {
    await saveSettings(sample());
    const loaded = await loadSettings();
    expect(loaded?.model).toBe("claude-opus-4-8");
    expect(loaded?.apiKeys.anthropic).toBe("sk-test");
    expect(isFirstRun(loaded)).toBe(false);
  });

  it("clears settings back to first-run", async () => {
    await saveSettings(sample());
    await clearSettings();
    expect(await loadSettings()).toBeNull();
  });

  it("round-trips the selected image-gen provider id (decision 6)", async () => {
    await saveSettings({ ...sample(), imageProviderId: "fal:flux-dev" });
    expect((await loadSettings())?.imageProviderId).toBe("fal:flux-dev");
  });
});

describe("R1.5 key indirection (proxy-ready)", () => {
  it("local resolver supplies the BYO key", () => {
    expect(toProviderSettings(sample()).apiKey).toBe("sk-test");
  });

  it("proxy resolver omits the key (the proxy holds it server-side)", () => {
    const ps = toProviderSettings(sample(), proxyKeyResolver());
    expect(ps.apiKey).toBeUndefined();
    expect(ps.providerId).toBe("anthropic");
    expect(ps.model).toBe("claude-opus-4-8");
  });
});
