// @vitest-environment jsdom
//
// SPEC-6 FR-19 — CommandPalette component test (jsdom + RTL). Covers the two jobs of the
// palette: action search over the shared registry (filter + run) and the quick-AI entry
// (wired to the same agent path). No model/network: the AI entry is exercised only up to
// the "viewport not ready" guard (no __plastiqBuild seam), proving the wiring is real.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CommandPalette } from "./CommandPalette.js";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
});

describe("CommandPalette (FR-19)", () => {
  it("renders nothing when closed and a dialog when open", () => {
    const { rerender } = render(<CommandPalette open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("command-palette")).toBeNull();
    rerender(<CommandPalette open onClose={() => {}} />);
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    expect(screen.getByTestId("command-palette-input")).toBeTruthy();
  });

  it("filters the registry actions by query", async () => {
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "loft" } });
    await waitFor(() => expect(screen.getByTestId("palette-action-loft")).toBeTruthy());

    // A non-matching query leaves NO action rows (the Ask-AI row is separate, tested below).
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "zzz-nope" } });
    await waitFor(() => expect(screen.queryByTestId("palette-action-loft")).toBeNull());
    expect(screen.queryAllByTestId(/^palette-action-/)).toHaveLength(0);
  });

  it("reports 'No matching commands' when nothing matches and no AI row applies", async () => {
    // No provider configured → no Ask-AI row; a non-matching query → an empty list.
    useAiStore.setState({ settings: null });
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "zzz-nope" } });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-results").textContent).toContain("No matching commands"),
    );
  });

  it("running an action executes it (adds the feature) and closes the palette", async () => {
    const onClose = vi.fn();
    const before = useCadStore.getState().features.length;
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "loft" } });
    await waitFor(() => expect(screen.getByTestId("palette-action-loft")).toBeTruthy());
    fireEvent.click(screen.getByTestId("palette-action-loft"));
    expect(useCadStore.getState().features.length).toBe(before + 1); // loft really ran
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers an 'Ask AI' entry for a non-empty query when a provider is configured", async () => {
    render(<CommandPalette open onClose={() => {}} />);
    expect(screen.queryByTestId("palette-ai")).toBeNull(); // empty query → no AI row
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "a 20mm cube" } });
    await waitFor(() => expect(screen.getByTestId("palette-ai").textContent).toContain("Ask AI: a 20mm cube"));
  });

  it("the AI entry drives the real agent path (guards when the viewport isn't ready)", async () => {
    // No __plastiqBuild seam → buildTurnTools returns null → the wiring reports the guard,
    // proving the AI entry is really wired to the agent turn (not a dead button).
    render(<CommandPalette open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("command-palette-input"), { target: { value: "a cube" } });
    await waitFor(() => expect(screen.getByTestId("palette-ai")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId("palette-ai"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-status").textContent).toContain("isn’t ready"),
    );
  });

  it("Escape closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette open onClose={onClose} />);
    fireEvent.keyDown(screen.getByTestId("command-palette-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
