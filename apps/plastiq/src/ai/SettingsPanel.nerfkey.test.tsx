// @vitest-environment jsdom
//
// SPEC-11 §5 — the NeRF service API key field (`settings-nerf-key`) in the Settings panel: a
// password input next to the NeRF URL field, prefilled from the persisted `nerfApiKey`, persisted
// trimmed via aiStore.save, and absent when left blank (the open dev default). Lives in its own
// file (vs SettingsPanel.test.tsx) so the NeRF-auth surface is covered independently.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SettingsPanel } from "./SettingsPanel.js";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";

const BASE_SETTINGS: AiSettings = {
  providerKey: "anthropic",
  providerId: "anthropic",
  model: "claude-opus-4-8",
  apiKeys: {},
};

beforeEach(() => {
  useAiStore.setState({ settings: { ...BASE_SETTINGS }, loaded: true });
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
});

describe("SettingsPanel — NeRF service API key (SPEC-11 §5)", () => {
  it("renders the NeRF key field as a password input, next to the NeRF URL field", () => {
    render(<SettingsPanel />);
    const input = screen.getByTestId("settings-nerf-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByTestId("settings-nerf-url")).toBeTruthy();
  });

  it("prefills from the persisted nerfApiKey", () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nerfApiKey: "nerf-abc" }, loaded: true });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-nerf-key") as HTMLInputElement).value).toBe("nerf-abc");
  });

  it("persists a trimmed nerfApiKey via aiStore.save", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-nerf-key"), { target: { value: "  nerf-secret " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.nerfApiKey).toBe("nerf-secret");
    });
  });

  it("leaves nerfApiKey absent when the field is blank (open dev service)", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.model).toBe("claude-opus-4-8"); // save did run
      expect(s.nerfApiKey).toBeUndefined();
    });
  });
});
