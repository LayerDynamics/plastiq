// @vitest-environment jsdom
//
// SPEC-6 R1.4 — SettingsPanel component test (jsdom + RTL). Focus: the FR-4/FR-5/FR-5b
// configuration surface is REACHABLE and persists — provider/model picker, free-text
// override, base-URL + service/proxy URLs, and the tool-capability preflight WARNING that
// FR-5b requires to be surfaced (previously computed but never shown), plus the debounced
// LIVE capability probe (§6.9) whose verdict supersedes the static hint.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsPanel } from "./SettingsPanel.js";
import { useAiStore } from "./aiStore.js";

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "anthropic", providerId: "anthropic", model: "claude-opus-4-8", apiKeys: {} },
    loaded: true,
  });
  // Keep every test hermetic: the panel's live capability probe (§6.9) must never reach
  // a real endpoint. Probe tests below re-stub this with their scripted responses.
  vi.stubGlobal("fetch", (async () => {
    throw new TypeError("network disabled in tests");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.indexedDB = new IDBFactory();
});

describe("SettingsPanel — configuration surface (FR-4/FR-5/FR-5b)", () => {
  it("renders provider, curated model picker, free-text override, and the service/proxy URLs", () => {
    render(<SettingsPanel />);
    expect(screen.getByTestId("settings-provider")).toBeTruthy();
    expect(screen.getByTestId("settings-model-select")).toBeTruthy(); // curated list (anthropic)
    expect(screen.getByTestId("settings-model")).toBeTruthy(); // free-text override
    expect(screen.getByTestId("settings-base-url")).toBeTruthy();
    expect(screen.getByTestId("settings-reconstruct-url")).toBeTruthy();
    expect(screen.getByTestId("settings-meshgen-url")).toBeTruthy();
    expect(screen.getByTestId("settings-fal-key")).toBeTruthy();
  });

  it("does NOT warn for a curated tool-capable model", () => {
    render(<SettingsPanel />); // anthropic / claude-opus-4-8 (supportsTools: true)
    expect(screen.queryByTestId("settings-tool-warning")).toBeNull();
  });

  it("surfaces the tool-capability warning for a custom (uncurated) model (FR-5b)", () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-model"), { target: { value: "some-random-model" } });
    const warn = screen.getByTestId("settings-tool-warning");
    expect(warn.textContent).toContain("tool calling");
  });

  it("persists provider/model/base-URL/keys/service URLs via aiStore.save", async () => {
    render(<SettingsPanel />);
    // Switch to the OpenAI-compatible preset (no curated models → free-text only).
    fireEvent.change(screen.getByTestId("settings-provider"), { target: { value: "openai" } });
    fireEvent.change(screen.getByTestId("settings-model"), { target: { value: "gpt-tool-x" } });
    fireEvent.change(screen.getByTestId("settings-base-url"), { target: { value: "https://proxy.example/v1" } });
    fireEvent.change(screen.getByTestId("settings-api-key"), { target: { value: "sk-123" } });
    fireEvent.change(screen.getByTestId("settings-reconstruct-url"), { target: { value: "https://recon.example" } });
    fireEvent.change(screen.getByTestId("settings-fal-key"), { target: { value: "fal-xyz" } });
    fireEvent.change(screen.getByTestId("settings-meshgen-url"), { target: { value: "https://falproxy.example" } });

    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });

    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.providerKey).toBe("openai");
      expect(s.providerId).toBe("openai-compatible");
      expect(s.model).toBe("gpt-tool-x");
      expect(s.baseURL).toBe("https://proxy.example/v1");
      expect(s.apiKeys["openai"]).toBe("sk-123");
      expect(s.apiKeys["fal"]).toBe("fal-xyz");
      expect(s.reconstructBaseURL).toBe("https://recon.example");
      expect(s.meshGenBaseURL).toBe("https://falproxy.example");
    });
  });

  it("reset returns to first-run (settings = null)", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-reset"));
    });
    await waitFor(() => expect(useAiStore.getState().settings).toBeNull());
  });
});

describe("SettingsPanel — live capability probe (FR-5b/§6.9)", () => {
  /** Scripted /api/show responder: selecting the Ollama preset fires the probe against it. */
  function stubOllamaShow(capabilities: string[]): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ capabilities }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch);
    return { calls };
  }

  it("selecting a model triggers the probe; a refuted verdict renders the hard warning", async () => {
    const { calls } = stubOllamaShow(["completion"]); // no "tools" ⇒ refuted
    render(<SettingsPanel />);
    // Switch to the Ollama preset — model resets to curated qwen3, which the STATIC
    // catalog marks tool-capable, so any warning that appears comes from the live probe.
    fireEvent.change(screen.getByTestId("settings-provider"), { target: { value: "ollama" } });
    expect(screen.queryByTestId("settings-tool-warning")).toBeNull();

    await waitFor(
      () => {
        expect(screen.getByTestId("settings-tool-warning").textContent).toContain("does not support tool calling");
      },
      { timeout: 4000 },
    );
    expect(calls.some((u) => u.endsWith("/api/show"))).toBe(true); // the probe actually fired
    expect(screen.queryByTestId("settings-tool-confirmed")).toBeNull();
  });

  it("a confirmed verdict renders the verified line and no warning", async () => {
    stubOllamaShow(["completion", "tools"]);
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-provider"), { target: { value: "ollama" } });

    await waitFor(
      () => {
        expect(screen.getByTestId("settings-tool-confirmed").textContent).toContain("verified against the endpoint");
      },
      { timeout: 4000 },
    );
    expect(screen.queryByTestId("settings-tool-warning")).toBeNull();
  });
});

describe("SettingsPanel — NURBS service fields (SPEC-12 §6.1)", () => {
  it("renders the NURBS URL field and the key field as a password input (settings-nurbs-key)", () => {
    render(<SettingsPanel />);
    expect(screen.getByTestId("settings-nurbs-url")).toBeTruthy();
    const key = screen.getByTestId("settings-nurbs-key") as HTMLInputElement;
    expect(key.type).toBe("password");
  });

  it("prefills from the persisted nurbsBaseURL/nurbsApiKey", () => {
    useAiStore.setState({
      settings: {
        providerKey: "anthropic",
        providerId: "anthropic",
        model: "claude-opus-4-8",
        apiKeys: {},
        nurbsBaseURL: "https://nurbs.example",
        nurbsApiKey: "nurbs-abc",
      },
      loaded: true,
    });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-nurbs-url") as HTMLInputElement).value).toBe("https://nurbs.example");
    expect((screen.getByTestId("settings-nurbs-key") as HTMLInputElement).value).toBe("nurbs-abc");
  });

  it("persists trimmed nurbsBaseURL/nurbsApiKey via aiStore.save", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-nurbs-url"), { target: { value: " https://nurbs.example " } });
    fireEvent.change(screen.getByTestId("settings-nurbs-key"), { target: { value: "  nurbs-secret " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.nurbsBaseURL).toBe("https://nurbs.example");
      expect(s.nurbsApiKey).toBe("nurbs-secret");
    });
  });

  it("leaves both absent when the fields are blank (client default + open dev service)", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.model).toBe("claude-opus-4-8"); // save did run
      expect(s.nurbsBaseURL).toBeUndefined();
      expect(s.nurbsApiKey).toBeUndefined();
    });
  });
});
