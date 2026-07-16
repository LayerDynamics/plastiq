// @vitest-environment jsdom
//
// SPEC-10 — the capture-service URL field (`settings-capture-url`) in the Settings panel: a text
// input for the point-cloud capture/completion service base URL, prefilled from the persisted
// `captureBaseURL`, persisted trimmed via aiStore.save (through the REAL settings store —
// fake-indexeddb), and absent when left blank so the @plastiq/capture client falls back to its
// default (http://localhost:8001). Lives in its own file (vs SettingsPanel.test.tsx), mirroring
// SettingsPanel.nerfkey.test.tsx, so the capture-service surface is covered independently.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // Keep every test hermetic: the panel's live capability probe (§6.9) must never reach
  // a real endpoint (same guard as SettingsPanel.test.tsx).
  vi.stubGlobal("fetch", (async () => {
    throw new TypeError("network disabled in tests");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.indexedDB = new IDBFactory();
});

describe("SettingsPanel — capture service URL (SPEC-10)", () => {
  it("renders the capture URL field with the documented dev default as its placeholder", () => {
    render(<SettingsPanel />);
    const input = screen.getByTestId("settings-capture-url") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.placeholder).toBe("http://localhost:8001");
    expect(input.value).toBe(""); // absent ⇒ the client default
  });

  it("prefills from the persisted captureBaseURL", () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, captureBaseURL: "http://capture.lan:9321" },
      loaded: true,
    });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-capture-url") as HTMLInputElement).value).toBe("http://capture.lan:9321");
  });

  it("persists a trimmed captureBaseURL via aiStore.save, and it survives a reload from IndexedDB", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-capture-url"), {
      target: { value: "  http://capture.lan:9321 " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.captureBaseURL).toBe("http://capture.lan:9321");
    });

    // Reload through the REAL settings store: wipe the in-memory slice and hydrate from
    // IndexedDB — the custom URL round-trips.
    useAiStore.setState({ settings: null, loaded: false });
    await act(async () => {
      await useAiStore.getState().load();
    });
    expect(useAiStore.getState().settings!.captureBaseURL).toBe("http://capture.lan:9321");
  });

  it("clearing the field back to blank drops captureBaseURL (client default again)", async () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, captureBaseURL: "http://capture.lan:9321" },
      loaded: true,
    });
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-capture-url"), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.model).toBe("claude-opus-4-8"); // save did run
      expect(s.captureBaseURL).toBeUndefined();
    });
  });
});
