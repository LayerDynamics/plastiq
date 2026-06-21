// @vitest-environment jsdom
//
// SPEC-6 R2.4/R4.3 — GenerationPanel component test (jsdom + RTL). Focus: the creative
// mesh-gen (fal) key affordance is REACHABLE by a real user — without it, create_mesh
// could never authenticate, so wiring the tool alone would be a feature no user can run.
// Asserts the field renders, starts "not configured", and saving a key flips it to
// configured (driving the real aiStore.save → settings).

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

beforeEach(() => {
  // A provider is configured (past first-run) and no mesh doc is open → the main panel.
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
});

describe("GenerationPanel — creative mesh-gen key is reachable", () => {
  it("renders the prompt and the creative-key affordance for a configured provider", () => {
    render(<GenerationPanel />);
    expect(screen.getByTestId("generation-prompt")).toBeTruthy();
    expect(screen.getByTestId("creative-key")).toBeTruthy();
    // Honest initial state: not configured (no fal key, no proxy).
    expect(screen.getByTestId("creative-key").textContent).toContain("not configured");
  });

  it("saving a fal key flips the affordance to configured (key reaches settings)", async () => {
    render(<GenerationPanel />);
    fireEvent.change(screen.getByTestId("creative-key-input"), { target: { value: "fal-secret" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("creative-key-save"));
    });
    // Wait on the real persisted value (the async aiStore.save → IndexedDB write). NB:
    // "configured" is a substring of "not configured", so assert on settings, not text.
    await waitFor(() => {
      expect(useAiStore.getState().settings?.apiKeys.fal).toBe("fal-secret");
    });
    expect(screen.getByTestId("creative-key").textContent).toContain("✓ configured");
  });
});
