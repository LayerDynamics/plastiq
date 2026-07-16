// beforeunload guard (Review #17): warn before closing/reloading a tab with
// unsaved changes. The projects store keeps no live "dirty" boolean — its dirty
// tracking lives inside the debounced crash-recovery SNAPSHOT (FR-40), which can
// lag an edit by up to 500 ms — so this module derives the live signal itself,
// subscribing read-only to the same stores the autosave wiring watches
// (persistence/projectsStore.ts: wireAutosave):
//   • dirty  — a document-affecting cad-store change (features/params/assembly)
//     while the projects store is not busy loading (a load is not a user edit);
//   • clean  — the projects status flips to a state where the on-disk project
//     IS the in-memory document ("saved", "opened", "new document");
//   • dirty — "recovered unsaved work": recover() clears the recovery snapshot,
//     so the restored document now lives ONLY in memory until saved.
// The prompt must NOT fire when clean: the listener returns without touching
// the event unless changes exist.

import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";

/** Statuses after which the in-memory document matches persistent storage. */
const CLEAN_STATUSES = new Set(["saved", "opened", "new document"]);

let dirty = false;

/** Live "unsaved changes" signal (exposed for tests + future UI). */
export function hasUnsavedChanges(): boolean {
  return dirty;
}

/**
 * Arm the guard: track dirtiness from the stores and prompt on beforeunload
 * while changes are unsaved. Returns a disposer (tests; the real app keeps it
 * armed for the page's lifetime). Installed once from main.tsx — module scope,
 * outside React, so StrictMode double-mounting can't double-register it.
 */
export function installUnsavedGuard(win: Window = window): () => void {
  dirty = false;
  const unsubDoc = useCadStore.subscribe((s, prev) => {
    if (s.features === prev.features && s.params === prev.params && s.assembly === prev.assembly) {
      return;
    }
    if (useProjectsStore.getState().busy) return; // mid-load → not a user edit
    dirty = true;
  });
  const unsubProjects = useProjectsStore.subscribe((s, prev) => {
    if (s.status === prev.status) return;
    if (CLEAN_STATUSES.has(s.status)) dirty = false;
    else if (s.status === "recovered unsaved work") dirty = true;
  });
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!dirty) return; // clean → leave the event completely untouched
    e.preventDefault();
    // Legacy channel some browsers still require; the text itself is ignored
    // by every modern browser (they show their own generic prompt).
    e.returnValue = "You have unsaved changes.";
  };
  win.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    win.removeEventListener("beforeunload", onBeforeUnload);
    unsubDoc();
    unsubProjects();
    dirty = false;
  };
}
