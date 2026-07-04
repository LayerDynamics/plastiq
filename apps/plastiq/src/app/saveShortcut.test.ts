// @vitest-environment jsdom
// ⌘/Ctrl+S (Review #17): named project → save in place; untitled → the same
// save-as prompt affordance as ProjectsMenu; preventDefault is unconditional
// for the chord (the browser's own save dialog must never open); non-chord
// keys fall through untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSaveShortcut } from "./saveShortcut.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

const save = vi.fn(async () => undefined);
const saveAs = vi.fn(async (_name: string) => undefined);
const original = {
  save: useProjectsStore.getState().save,
  saveAs: useProjectsStore.getState().saveAs,
};

function chord(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

beforeEach(() => {
  save.mockClear();
  saveAs.mockClear();
  useProjectsStore.setState({ save, saveAs, currentId: null, currentName: "Untitled" });
});
afterEach(() => {
  useProjectsStore.setState({ ...original, currentId: null, currentName: "Untitled" });
  vi.restoreAllMocks();
});

describe("handleSaveShortcut", () => {
  it("⌘S on a named project saves in place (no prompt)", () => {
    useProjectsStore.setState({ currentId: "p1", currentName: "Bracket" });
    const prompt = vi.spyOn(window, "prompt");
    const e = chord({ key: "s", metaKey: true });
    expect(handleSaveShortcut(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saveAs).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("Ctrl+S works the same as ⌘S", () => {
    useProjectsStore.setState({ currentId: "p1", currentName: "Bracket" });
    const e = chord({ key: "S", ctrlKey: true });
    expect(handleSaveShortcut(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("⌘S on an untitled document prompts for a name and saves-as (trimmed)", () => {
    vi.spyOn(window, "prompt").mockReturnValue("  My Part  ");
    const e = chord({ key: "s", metaKey: true });
    expect(handleSaveShortcut(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(saveAs).toHaveBeenCalledWith("My Part");
    expect(save).not.toHaveBeenCalled();
  });

  it("a cancelled save-as prompt saves nothing but still consumes the chord", () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    const e = chord({ key: "s", metaKey: true });
    expect(handleSaveShortcut(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true); // browser dialog still suppressed
    expect(saveAs).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("falls through on non-chord keys without touching the event", () => {
    for (const e of [chord({ key: "s" }), chord({ key: "a", metaKey: true })]) {
      expect(handleSaveShortcut(e)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(save).not.toHaveBeenCalled();
    expect(saveAs).not.toHaveBeenCalled();
  });
});
