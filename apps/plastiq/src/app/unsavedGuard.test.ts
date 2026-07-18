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
import type { MeshDoc } from "../store/types.js";

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
  useProjectsStore.setState({ busy: false, status: "", activeMeshDoc: null });
  dispose = installUnsavedGuard();
});
afterEach(() => {
  dispose?.();
  dispose = null;
  useProjectsStore.setState({ busy: false, status: "", activeMeshDoc: null });
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

  it("§2.12.3: a mesh-document edit arms the prompt (the mesh IS the document)", () => {
    const mesh: MeshDoc = { kind: "mesh", name: "Blob", glb: "R0xC", source: { mode: "text3d", providerId: "fal:tripo" } };
    useProjectsStore.setState({ activeMeshDoc: mesh, busy: false });
    expect(hasUnsavedChanges()).toBe(true);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);

    // A save cleans it; sculpting again re-arms.
    useProjectsStore.setState({ status: "saved" });
    expect(hasUnsavedChanges()).toBe(false);
    useProjectsStore.setState({ activeMeshDoc: { ...mesh, glb: "R0xCZWRpdGVk" } });
    expect(hasUnsavedChanges()).toBe(true);
  });

  it("§2.12.3: opening/recovering a mesh project is NOT an edit", () => {
    const mesh: MeshDoc = { kind: "mesh", name: "Blob", glb: "R0xC", source: { mode: "text3d", providerId: "fal:tripo" } };
    // recover(): busy stays true across the doc install.
    useProjectsStore.setState({ busy: true });
    useProjectsStore.setState({ activeMeshDoc: mesh });
    expect(hasUnsavedChanges()).toBe(false);

    // open(): busy is cleared in the SAME set that installs the doc.
    useProjectsStore.setState({ activeMeshDoc: null, busy: true });
    useProjectsStore.setState({ activeMeshDoc: mesh, status: "opened", busy: false });
    expect(hasUnsavedChanges()).toBe(false);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("§2.12.3: leaving mesh mode (doc → null) is not an edit", () => {
    const mesh: MeshDoc = { kind: "mesh", name: "Blob", glb: "R0xC", source: { mode: "text3d", providerId: "fal:tripo" } };
    useProjectsStore.setState({ activeMeshDoc: mesh, busy: true });
    useProjectsStore.setState({ busy: false, status: "saved" });
    expect(hasUnsavedChanges()).toBe(false);
    useProjectsStore.setState({ activeMeshDoc: null }); // converted to CAD / closed
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("the disposer removes the listener", () => {
    editDocument();
    dispose?.();
    dispose = null;
    const e = fireBeforeUnload();
    expect(e.defaultPrevented).toBe(false);
  });
});
