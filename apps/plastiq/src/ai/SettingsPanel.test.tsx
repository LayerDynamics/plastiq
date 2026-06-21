// @vitest-environment jsdom
//
// SPEC-6 R1.4 — SettingsPanel component test (jsdom + RTL). Focus: the FR-4/FR-5/FR-5b
// configuration surface is REACHABLE and persists — provider/model picker, free-text
// override, base-URL + service/proxy URLs, and the tool-capability preflight WARNING that
// FR-5b requires to be surfaced (previously computed but never shown).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsPanel } from "./SettingsPanel.js";
import { useAiStore } from "./aiStore.js";

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "anthropic", providerId: "anthropic", model: "claude-opus-4-8", apiKeys: {} },
    loaded: true,
  });
});

afterEach(() => {
  cleanup();
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
