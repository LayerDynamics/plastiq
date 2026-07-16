// @vitest-environment jsdom
//
// P0.1 — capture + reconstruct service API keys in Settings (parity with nerf/nurbs/photogrammetry).
// Password fields, prefill from persisted AiSettings, trimmed save, absent when blank.

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

describe("SettingsPanel — reconstruct API key (P0.1)", () => {
  it("renders the reconstruct key as a password input next to the reconstruct URL", () => {
    render(<SettingsPanel />);
    const input = screen.getByTestId("settings-reconstruct-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByTestId("settings-reconstruct-url")).toBeTruthy();
  });

  it("prefills from the persisted reconstructApiKey", () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, reconstructApiKey: "recon-abc" },
      loaded: true,
    });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-reconstruct-key") as HTMLInputElement).value).toBe("recon-abc");
  });

  it("persists a trimmed reconstructApiKey via aiStore.save", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-reconstruct-key"), {
      target: { value: "  recon-secret " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.reconstructApiKey).toBe("recon-secret");
    });
  });

  it("leaves reconstructApiKey absent when the field is blank", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.reconstructApiKey).toBeUndefined();
    });
  });
});

describe("SettingsPanel — capture API key (P0.1)", () => {
  it("renders the capture key as a password input next to the capture URL", () => {
    render(<SettingsPanel />);
    const input = screen.getByTestId("settings-capture-key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(screen.getByTestId("settings-capture-url")).toBeTruthy();
  });

  it("prefills from the persisted captureApiKey", () => {
    useAiStore.setState({
      settings: { ...BASE_SETTINGS, captureApiKey: "cap-abc" },
      loaded: true,
    });
    render(<SettingsPanel />);
    expect((screen.getByTestId("settings-capture-key") as HTMLInputElement).value).toBe("cap-abc");
  });

  it("persists a trimmed captureApiKey via aiStore.save and survives IndexedDB reload", async () => {
    render(<SettingsPanel />);
    fireEvent.change(screen.getByTestId("settings-capture-key"), {
      target: { value: "  cap-secret " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.captureApiKey).toBe("cap-secret");
    });

    useAiStore.setState({ settings: null, loaded: false });
    await act(async () => {
      await useAiStore.getState().load();
    });
    expect(useAiStore.getState().settings!.captureApiKey).toBe("cap-secret");
  });

  it("leaves captureApiKey absent when the field is blank", async () => {
    render(<SettingsPanel />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-save"));
    });
    await waitFor(() => {
      expect(useAiStore.getState().settings!.captureApiKey).toBeUndefined();
    });
  });
});
