// @vitest-environment jsdom
// beforeunload guard (Review #17): dirty (a document edit) → the prompt fires
// (preventDefault + returnValue); clean (fresh boot, or after save/open/new) →
// the event is left completely untouched.
//
// jsdom legacy Event semantics: `returnValue` is the INVERSE of the canceled
// flag (true = not canceled), so after preventDefault it reads false — the
// assertions below check defaultPrevented (the modern channel) plus
// returnValue !== true (the legacy one flipped).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installUnsavedGuard, hasUnsavedChanges } from "./unsavedGuard.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

let dispose: (() => void) | null = null;

function fireBeforeUnload(): Event {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e;
}

/** A document-affecting change (new features identity), like a real edit. */
function editDocument(): void {
  useCadStore.setState((s) => ({ features: [...s.features] }));
}

beforeEach(() => {
  useProjectsStore.setState({ busy: false, status: "" });
  dispose = installUnsavedGuard();
});
afterEach(() => {
  dispose?.();
  dispose = null;
  useProjectsStore.setState({ busy: false, status: "" });
});

describe("installUnsavedGuard", () => {
  it("does not touch the event while nothing changed", () => {
    const e = fireBeforeUnload();
    expect(hasUnsavedChanges()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect((e as BeforeUnloadEvent).returnValue).toBe(true); // untouched legacy default
  });

  it("prompts once a document edit made the session dirty", () => {
    editDocument();
    expect(hasUnsavedChanges()).toBe(true);
    const e = fireBeforeUnload();
    expect(e.defaultPrevented).toBe(true);
    expect((e as BeforeUnloadEvent).returnValue).not.toBe(true); // legacy channel flipped
  });

  it("a save makes the session clean again (no prompt), and a new edit re-arms it", () => {
    editDocument();
    useProjectsStore.setState({ status: "saving…" });
    useProjectsStore.setState({ status: "saved" });
    expect(hasUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);

    editDocument();
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it("open / new document also mark the session clean", () => {
    for (const status of ["opened", "new document"]) {
      editDocument();
      useProjectsStore.setState({ status: "" });
      useProjectsStore.setState({ status });
      expect(hasUnsavedChanges()).toBe(false);
    }
  });

  it("recovered unsaved work counts as dirty (it lives only in memory)", () => {
    useProjectsStore.setState({ status: "recovered unsaved work" });
    expect(hasUnsavedChanges()).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it("ignores document churn while the projects store is busy loading", () => {
    useProjectsStore.setState({ busy: true });
    editDocument();
    useProjectsStore.setState({ busy: false });
    expect(hasUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("the disposer removes the listener", () => {
    editDocument();
    dispose?.();
    dispose = null;
    const e = fireBeforeUnload();
    expect(e.defaultPrevented).toBe(false);
  });
});
