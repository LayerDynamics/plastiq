// Projects state (SPEC-5 M5.3): bridges the SQLite ProjectStore to the document
// store (useCadStore). Holds the project list + the open project's id/name, and
// the new/open/save/save-as/rename/delete actions the UI calls. The store is
// loaded lazily (its SQLite WASM is heavy); a thumbnail provider is registered
// by the viewport so Save captures the canvas.

import { create } from "zustand";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";
import { projectStore } from "./index.js";
import { clearRecovery, readRecovery, writeRecovery, type RecoverySnapshot } from "./recovery.js";
import type { ProjectMeta, ProjectStore } from "./types.js";

/** Debounced autosave (FR-40): persist the open project a quiet interval after
 * its document changes. Wired once, after the store loads. */
const AUTOSAVE_DELAY_MS = 1500;
const RECOVERY_DELAY_MS = 500;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

/** Schedule a debounced dirty crash-recovery snapshot (JSON.stringify +
 * localStorage.setItem are blocking, so coalesce rapid edits/drags). */
function scheduleRecovery(snapshot: () => RecoverySnapshot): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => writeRecovery(snapshot()), RECOVERY_DELAY_MS);
}

/** Cancel a pending dirty snapshot (a save is about to write a clean one). */
function cancelPendingRecovery(): void {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }
}

let autosaveWired = false;
function wireAutosave(get: () => ProjectsState): void {
  if (autosaveWired) return;
  autosaveWired = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  useCadStore.subscribe((s, prev) => {
    if (s.features === prev.features && s.params === prev.params && s.assembly === prev.assembly) {
      return;
    }
    const ps = get();
    if (ps.busy) return; // mid-load → not a user edit
    // Crash-recovery snapshot (debounced) — captures even an untitled document so
    // a reload/crash before any named save can still be recovered (FR-40). The
    // thunk reads the latest doc when the timer fires.
    scheduleRecovery(() => ({
      doc: useCadStore.getState().toDocument(),
      name: get().currentName,
      currentId: get().currentId,
      dirty: true,
      savedAt: Date.now(),
    }));
    if (!ps.currentId) return; // untitled → no named project to autosave (yet)
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void get().save(), AUTOSAVE_DELAY_MS);
  });
}

export interface ProjectsState {
  store: ProjectStore | null;
  list: ProjectMeta[];
  currentId: string | null;
  currentName: string;
  /** Status line ("saved", "saving…", error). */
  status: string;
  thumbnail: (() => string | null) | null;
  /** True while loading a document (open/new/saveAs) — suppresses autosave. */
  busy: boolean;
  /** A dirty recovery snapshot found at startup (a prior crash), else null. */
  recoverable: RecoverySnapshot | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setThumbnailProvider: (provider: (() => string | null) | null) => void;
  newProject: () => void;
  open: (id: string) => Promise<void>;
  save: () => Promise<void>;
  saveAs: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Load the recovered document (FR-40) and clear the recovery state. */
  recover: () => void;
  /** Discard the recovery snapshot without loading it. */
  dismissRecovery: () => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  store: null,
  list: [],
  currentId: null,
  currentName: "Untitled",
  status: "",
  thumbnail: null,
  busy: false,
  recoverable: null,

  init: async () => {
    if (get().store) return;
    const store = await projectStore();
    set({ store });
    await get().refresh();
    // Surface a dirty recovery snapshot from a previous crash (FR-40); the UI
    // prompts the user to recover or discard. Wire autosave AFTER, so reading
    // the snapshot doesn't get overwritten by the first edit.
    const snap = readRecovery();
    if (snap?.dirty) set({ recoverable: snap });
    wireAutosave(get);
  },

  refresh: async () => {
    const store = get().store;
    if (!store) return;
    set({ list: await store.list() });
  },

  setThumbnailProvider: (provider) => set({ thumbnail: provider }),

  newProject: () => {
    set({ busy: true });
    useCadStore.getState().loadDocument(defaultDocument());
    set({ currentId: null, currentName: "Untitled", status: "new document", busy: false });
  },

  open: async (id) => {
    const store = get().store;
    if (!store) return;
    const project = await store.load(id);
    if (!project) {
      set({ status: "project not found" });
      return;
    }
    set({ busy: true });
    useCadStore.getState().loadDocument(project.doc);
    set({ currentId: id, currentName: project.meta.name, status: "opened", busy: false });
  },

  save: async () => {
    const { store, currentId, currentName, thumbnail } = get();
    if (!store) return;
    if (!currentId) {
      await get().saveAs(currentName === "Untitled" ? "Untitled" : currentName);
      return;
    }
    set({ status: "saving…" });
    await store.save(currentId, useCadStore.getState().toDocument(), thumbnail?.() ?? null);
    await get().refresh();
    set({ status: "saved" });
    // The on-disk project is now current → the recovery snapshot is clean. Cancel
    // any pending dirty write so it can't clobber this clean one.
    cancelPendingRecovery();
    writeRecovery({
      doc: useCadStore.getState().toDocument(),
      name: currentName,
      currentId,
      dirty: false,
      savedAt: Date.now(),
    });
  },

  saveAs: async (name) => {
    const { store, thumbnail } = get();
    if (!store) return;
    set({ status: "saving…" });
    const meta = await store.create(name, useCadStore.getState().toDocument());
    // Attach the thumbnail in the same flow.
    await store.save(meta.id, useCadStore.getState().toDocument(), thumbnail?.() ?? null);
    await get().refresh();
    set({ currentId: meta.id, currentName: name, status: "saved" });
    cancelPendingRecovery();
    writeRecovery({
      doc: useCadStore.getState().toDocument(),
      name,
      currentId: meta.id,
      dirty: false,
      savedAt: Date.now(),
    });
  },

  rename: async (id, name) => {
    const store = get().store;
    if (!store) return;
    await store.rename(id, name);
    await get().refresh();
    if (get().currentId === id) set({ currentName: name });
  },

  remove: async (id) => {
    const store = get().store;
    if (!store) return;
    await store.delete(id);
    await get().refresh();
    if (get().currentId === id)
      set({ currentId: null, currentName: "Untitled", status: "deleted" });
  },

  recover: () => {
    const snap = get().recoverable;
    if (!snap) return;
    set({ busy: true });
    useCadStore.getState().loadDocument(snap.doc);
    set({
      currentId: snap.currentId,
      currentName: snap.name,
      status: "recovered unsaved work",
      recoverable: null,
      busy: false,
    });
    clearRecovery();
  },

  dismissRecovery: () => {
    clearRecovery();
    set({ recoverable: null });
  },
}));
