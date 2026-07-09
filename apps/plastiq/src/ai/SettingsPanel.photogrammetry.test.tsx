// @vitest-environment jsdom
//
// SPEC-13 P11.2 — the photogrammetry-service fields (`settings-photogrammetry-url` /
// `settings-photogrammetry-key`) in the Settings panel: the SfM+MVS service base URL + optional API
// key, prefilled from the persisted `photogrammetryBaseURL`/`photogrammetryApiKey`, persisted trimmed
// via aiStore.save (through the REAL settings store — fake-indexeddb), and absent when blank so the
// @plastiq/photogrammetry client falls back to its default (http://localhost:8004) / open auth. Lives
// in its own file, mirroring SettingsPanel.capture.test.tsx / SettingsPanel.nerfkey.test.tsx.

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
  vi.stubGlobal("fetch", (async () => {
    throw new TypeError("network disabled in tests");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.indexedDB = new IDBFactory();
});

describe("SettingsPanel — photogrammetry service fields (SPEC-13)", () => {
  it("renders the URL (text) + key (password) fields with the documented defaults", () => {
    render(<SettingsPanel />);
    const url = screen.getByTestId("settings-photogrammetry-url") as HTMLInputElement;
    expect(url.type).toBe("text");
    expect(url.placeholder).toBe("http://localhost:8004");
    expect(url.value).toBe("");
    const key = screen.getByTestId("settings-photogrammetry-key") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
  });

  it("prefills from the persisted photogrammetryBaseURL / photogrammetryApiKey", () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, photogrammetryBaseURL: "http://pg.lan:9004", photogrammetryApiKey: "sfm-secret" },
      loaded: true,
    });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-photogrammetry-url") as HTMLInputElement).value).toBe("http://pg.lan:9004");
    expect((screen.getByTestId("settings-photogrammetry-key") as HTMLInputElement).value).toBe("sfm-secret");
  });

  it("persists trimmed URL + key via aiStore.save, surviving a reload from IndexedDB", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-photogrammetry-url"), { target: { value: "  http://pg.lan:9004 " } });
    fireEvent.change(screen.getByTestId("settings-photogrammetry-key"), { target: { value: " sfm-secret " } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.photogrammetryBaseURL).toBe("http://pg.lan:9004");
      expect(useAiStore.getState().settings!.photogrammetryApiKey).toBe("sfm-secret");
    });

    // Reload through the REAL settings store.
    useAiStore.setState({ settings: null, loaded: false });
    await act(async () => {
      await useAiStore.getState().load();
    });
    expect(useAiStore.getState().settings!.photogrammetryBaseURL).toBe("http://pg.lan:9004");
    expect(useAiStore.getState().settings!.photogrammetryApiKey).toBe("sfm-secret");
  });

  it("clearing the fields drops them (client default + open auth again)", async () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, photogrammetryBaseURL: "http://pg.lan:9004", photogrammetryApiKey: "sfm-secret" },
      loaded: true,
    });
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-photogrammetry-url"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("settings-photogrammetry-key"), { target: { value: "" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      const s = useAiStore.getState().settings!;
      expect(s.model).toBe("claude-opus-4-8"); // save did run
      expect(s.photogrammetryBaseURL).toBeUndefined();
      expect(s.photogrammetryApiKey).toBeUndefined();
    });
  });
});
