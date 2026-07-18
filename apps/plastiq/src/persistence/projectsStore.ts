// Projects state (SPEC-5 M5.3): bridges the SQLite ProjectStore to the document
// store (useCadStore). Holds the project list + the open project's id/name, and
// the new/open/save/save-as/rename/delete actions the UI calls. The store is
// loaded lazily (its SQLite WASM is heavy); a thumbnail provider is registered
// by the viewport so Save captures the canvas.
//
// Document kinds (PersistedDoc): a parametric CadDocument lives in useCadStore, a
// generated MeshDoc in `activeMeshDoc`, and a voxel sculpt (ADR-0010) in
// useVoxelStore — open/save/autosave/recovery route on the document's kind.

import { create } from "zustand";
import { useCadStore } from "../store/store.js";
import { useAiStore } from "../ai/aiStore.js";
import { defaultDocument } from "../store/seed.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { defaultVoxelDoc } from "../voxel/doc.js";
import { projectStore } from "./index.js";
import {
  clearRecovery,
  hydrateRecovery,
  readRecovery,
  writeRecovery,
  type RecoverySnapshot,
  type RecoveryWriteResult,
} from "./recovery.js";
import type { ProjectMeta, ProjectStore } from "./types.js";
import {
  isMeshDoc,
  isPointCloudDoc,
  isVoxelDoc,
  type CadDocument,
  type MeshDoc,
  type PersistedDoc,
  type PointCloudDoc,
  type VoxelDoc,
} from "../store/types.js";

/** Debounced autosave (FR-40): persist the open project a quiet interval after
 * its document changes. Wired once, after the store loads. */
const AUTOSAVE_DELAY_MS = 1500;
const RECOVERY_DELAY_MS = 500;
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
// Module scope, NOT wireAutosave's closure: a project switch must be able to cancel
// a pending autosave from outside (§2.12.4).
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

/** Surface a failed recovery-snapshot write on the status line (Review #13).
 * Quota exhaustion means crash recovery is NOT protecting the current work, so
 * the user must save; the write itself stays best-effort and never throws. */
function surfaceRecoveryFailure(result: RecoveryWriteResult): void {
  if (result.ok) return;
  useProjectsStore.setState({
    status:
      result.reason === "quota"
        ? "recovery snapshot failed (storage full) — save your work"
        : `recovery snapshot failed — save your work (${result.message})`,
  });
}

/** Schedule a debounced dirty crash-recovery snapshot (JSON.stringify +
 * localStorage.setItem are blocking, so coalesce rapid edits/drags). A failed
 * write is reported on the status line, never swallowed (Review #13). */
function scheduleRecovery(snapshot: () => RecoverySnapshot): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(
    () => void writeRecovery(snapshot()).then(surfaceRecoveryFailure),
    RECOVERY_DELAY_MS,
  );
}

/** Cancel a pending dirty snapshot (a save is about to write a clean one). */
function cancelPendingRecovery(): void {
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
  }
}

/**
 * Cancel EVERY pending persistence timer — the debounced dirty snapshot and the
 * debounced autosave — before switching what "the current project" means
 * (§2.12.4).
 *
 * Both thunks read the LIVE state when they fire, not when they were scheduled:
 * the recovery thunk snapshots `liveDocument()` under `currentId`/`currentName`,
 * and the autosave thunk calls `save()`. So a project switch inside the debounce
 * window (1.5 s) made a pending timer describe the WRONG project — it dropped
 * the old project's un-persisted edits and then snapshotted the freshly-opened
 * project as dirty, or saved the new document under the old one's id.
 *
 * Cancelling is correct rather than lossy: `open()`/`newProject()` replace the
 * live document wholesale, so a timer scheduled for the outgoing document can no
 * longer read it — there is nothing left to persist by the time it would fire.
 */
function cancelPendingPersistence(): void {
  cancelPendingRecovery();
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }
}

/** Best-effort message from an unknown thrown value (Error, DOMException, …). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The document to persist for the OPEN project: the open mesh document when one
 * is active (mesh mode, SPEC-6 decision 20), else the live voxel sculpt when one is
 * open (voxel mode), else the parametric editor document. Deep-copied in every case
 * so a stored document never aliases live state (toDocument already clones). Without
 * the mesh branch, save()/autosave on an open mesh project would clobber its stored
 * GLB with the (empty) parametric editor document. */
function liveDocument(): PersistedDoc {
  const { activeMeshDoc, activePointCloudDoc } = useProjectsStore.getState();
  if (activeMeshDoc) return structuredClone(activeMeshDoc);
  if (activePointCloudDoc) return structuredClone(activePointCloudDoc);
  const voxel = useVoxelStore.getState().doc;
  return voxel ? structuredClone(voxel) : useCadStore.getState().toDocument();
}

/** Wrap a document for the recovery-snapshot machinery (persistence/recovery.ts),
 * which is typed over CadDocument and walks `doc.features` for import-payload
 * compaction. A voxel sculpt or a mesh document rides in an envelope with empty
 * features/params: the compaction pass no-ops over it, JSON round-trips it verbatim
 * (a MeshDoc is plain JSON — kind/name/glb/source), and {@link voxelOfRecoveryDoc} /
 * {@link meshOfRecoveryDoc} unwrap it on recover. Parametric docs pass through.
 * Passing a MeshDoc through UNwrapped would make writeRecovery throw (it iterates
 * `doc.features`, absent on a MeshDoc) and report "recovery snapshot failed". */
function toRecoveryDoc(doc: PersistedDoc): CadDocument {
  if (isVoxelDoc(doc)) return { features: [], params: {}, voxel: doc } as CadDocument;
  if (isMeshDoc(doc)) return { features: [], params: {}, mesh: doc } as CadDocument;
  if (isPointCloudDoc(doc)) return { features: [], params: {}, pointCloud: doc } as CadDocument;
  return doc as CadDocument;
}

/** The voxel document inside a recovery snapshot's envelope, or null. */
export function voxelOfRecoveryDoc(doc: CadDocument): VoxelDoc | null {
  const v = (doc as { voxel?: unknown }).voxel;
  return isVoxelDoc(v) ? v : null;
}

/** The mesh document inside a recovery snapshot's envelope, or null. */
export function meshOfRecoveryDoc(doc: CadDocument): MeshDoc | null {
  const m = (doc as { mesh?: unknown }).mesh;
  return typeof m === "object" && m !== null && isMeshDoc(m as PersistedDoc)
    ? (m as MeshDoc)
    : null;
}

/** The point-cloud document inside a recovery snapshot's envelope, or null. */
export function pointCloudOfRecoveryDoc(doc: CadDocument): PointCloudDoc | null {
  const p = (doc as { pointCloud?: unknown }).pointCloud;
  return isPointCloudDoc(p) ? p : null;
}

/** Enter/leave the Sculpt workspace to match the document kind being opened, so a
 * voxel project always lands on its tools and a non-voxel document never strands
 * the user on the (all-disabled) sculpt toolset. */
function syncWorkspace(voxel: boolean): void {
  const cad = useCadStore.getState();
  if (voxel && cad.workspace !== "sculpt") cad.setWorkspace("sculpt");
  if (!voxel && cad.workspace === "sculpt") cad.setWorkspace("design");
}

let autosaveWired = false;
function wireAutosave(get: () => ProjectsState): void {
  if (autosaveWired) return;
  autosaveWired = true;
  // Shared reaction to a live document edit (parametric or voxel): schedule the
  // debounced dirty crash-recovery snapshot — capturing even an untitled document
  // so a reload/crash before any named save can still be recovered (FR-40); the
  // thunk reads the latest LIVE document when the timer fires — and, for a named
  // project, the debounced autosave.
  const onEdit = (): void => {
    scheduleRecovery(() => ({
      doc: toRecoveryDoc(liveDocument()),
      name: get().currentName,
      currentId: get().currentId,
      dirty: true,
      savedAt: Date.now(),
    }));
    if (!get().currentId) return; // untitled → no named project to autosave (yet)
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void get().save(), AUTOSAVE_DELAY_MS);
  };
  useCadStore.subscribe((s, prev) => {
    if (s.features === prev.features && s.params === prev.params && s.assembly === prev.assembly) {
      return;
    }
    if (get().busy) return; // mid-load → not a user edit
    onEdit();
  });
  // Voxel sculpt edits (ADR-0010): same debounce + recovery discipline. Open/close
  // transitions are project loads, not edits — `busy` guards the former and the
  // `!s.doc` check skips the latter.
  useVoxelStore.subscribe((s, prev) => {
    if (s.doc === prev.doc || !s.doc) return;
    if (get().busy) return;
    onEdit();
  });
  // Mesh-document edits (§2.12.3). For a generated/sculpted mesh project the MESH
  // *is* the document — it lives in this store's `activeMeshDoc`, not the cad or
  // voxel store — so without this subscription sculpt edits were never autosaved
  // and never snapshotted for crash recovery: close the tab and they were gone.
  // liveDocument()/toRecoveryDoc() already handle a MeshDoc, so onEdit just works.
  //
  // Guards: a null doc is LEAVING mesh mode, not an edit; `busy` covers recover();
  // and `prev.busy` covers open(), which clears busy in the SAME atomic set that
  // installs the opened doc (so checking only `s.busy` would read false and treat
  // the load's tail as an edit).
  useProjectsStore.subscribe((s, prev) => {
    if (s.activeMeshDoc === prev.activeMeshDoc || !s.activeMeshDoc) return;
    if (s.busy || prev.busy) return;
    onEdit();
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
  /** The open project's mesh document when it is a mesh-kind project (SPEC-6
   * decision 20); null for a parametric project. The viewport renders it from its
   * GLB; the parametric editor (cad store) stays empty for a mesh project. */
  activeMeshDoc: MeshDoc | null;
  /** The open project's point-cloud document when it is a cloud-kind project (SPEC-13); null
   * otherwise. Mutually exclusive with activeMeshDoc + the voxel/parametric modes: the viewport
   * renders it as a THREE.Points cloud and the parametric editor stays empty for it. */
  activePointCloudDoc: PointCloudDoc | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  setThumbnailProvider: (provider: (() => string | null) | null) => void;
  newProject: () => void;
  /** Start a fresh untitled voxel sculpt (ADR-0010): opens the default grid in the
   * voxel store and switches to the Sculpt workspace. Save/autosave then persist it
   * as a `kind:"voxel"` project through the normal save path. */
  newVoxelProject: () => void;
  /** Persist a generated MESH document as a NEW project (the create_mesh creative path,
   * SPEC-6 R4.3). Returns the new project id. Deliberately does NOT switch the open
   * project or set activeMeshDoc — the caller opens it AFTER the agent loop finishes so
   * a successful generation never yanks the panel out from under a still-running run. */
  createMeshProject: (doc: MeshDoc) => Promise<string>;
  /** Persist a dense point-cloud document as a NEW project (SPEC-13), returning its id. Like
   * createMeshProject it does NOT switch the open project — the caller opens it afterwards. */
  createPointCloudProject: (doc: PointCloudDoc) => Promise<string>;
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
  activeMeshDoc: null,
  activePointCloudDoc: null,

  init: async () => {
    if (get().store) return;
    const store = await projectStore();
    set({ store });
    await get().refresh();
    // Surface a dirty recovery snapshot from a previous crash (FR-40); the UI
    // prompts the user to recover or discard. Hydrate it first: a snapshot may
    // carry compacted `stepRef` import-payload references (Review #13), and
    // recover() must load a document that rebuilds identically. Wire autosave
    // AFTER, so reading the snapshot doesn't get overwritten by the first edit.
    const snap = readRecovery();
    if (snap?.dirty) set({ recoverable: await hydrateRecovery(snap) });
    wireAutosave(get);
  },

  refresh: async () => {
    const store = get().store;
    if (!store) return;
    set({ list: await store.list() });
  },

  setThumbnailProvider: (provider) => set({ thumbnail: provider }),

  newProject: () => {
    cancelPendingPersistence(); // §2.12.4: the outgoing document's timers are stale
    set({ busy: true });
    useVoxelStore.getState().close(); // a new parametric doc leaves voxel mode
    syncWorkspace(false);
    useCadStore.getState().loadDocument(defaultDocument());
    set({ activeMeshDoc: null, activePointCloudDoc: null, currentId: null, currentName: "Untitled", status: "new document", busy: false });
    void useAiStore.getState().openConversation(null); // fresh untitled → empty conversation
  },

  newVoxelProject: () => {
    cancelPendingPersistence(); // §2.12.4
    set({ busy: true });
    useVoxelStore.getState().open(defaultVoxelDoc());
    syncWorkspace(true);
    set({ activeMeshDoc: null, activePointCloudDoc: null, currentId: null, currentName: "Untitled", status: "new voxel sculpt", busy: false });
    void useAiStore.getState().openConversation(null); // fresh untitled → empty conversation
  },

  createMeshProject: async (doc) => {
    const store = get().store;
    if (!store) throw new Error("projects store not initialised");
    const meta = await store.create(doc.name ?? "Generated mesh", doc);
    await get().refresh();
    return meta.id;
  },

  createPointCloudProject: async (doc) => {
    const store = get().store;
    if (!store) throw new Error("projects store not initialised");
    const meta = await store.create(doc.name ?? "Point cloud", doc);
    await get().refresh();
    return meta.id;
  },

  open: async (id) => {
    const store = get().store;
    if (!store) return;
    const project = await store.load(id);
    if (!project) {
      set({ status: "project not found" });
      return;
    }
    // §2.12.4: drop the outgoing project's pending timers BEFORE the swap — they
    // read live state at fire time and would describe the incoming project.
    cancelPendingPersistence();
    set({ busy: true });
    if (isMeshDoc(project.doc)) {
      // A generated mesh project (decision 20): held as activeMeshDoc and rendered
      // from its GLB by the viewport; the parametric cad store stays empty for it.
      useVoxelStore.getState().close();
      syncWorkspace(false);
      set({ activeMeshDoc: project.doc, activePointCloudDoc: null, currentId: id, currentName: project.meta.name, status: "opened", busy: false });
    } else if (isPointCloudDoc(project.doc)) {
      // A dense point-cloud project (SPEC-13): held as activePointCloudDoc and rendered as a
      // THREE.Points cloud; the parametric cad store + voxel store stay empty for it.
      useVoxelStore.getState().close();
      syncWorkspace(false);
      set({ activeMeshDoc: null, activePointCloudDoc: project.doc, currentId: id, currentName: project.meta.name, status: "opened", busy: false });
    } else if (isVoxelDoc(project.doc)) {
      // A voxel sculpt (ADR-0010): opened into the voxel store and edited in the
      // Sculpt workspace; the parametric cad store stays untouched for it.
      useVoxelStore.getState().open(project.doc);
      syncWorkspace(true);
      set({ activeMeshDoc: null, activePointCloudDoc: null, currentId: id, currentName: project.meta.name, status: "opened", busy: false });
    } else {
      useVoxelStore.getState().close();
      syncWorkspace(false);
      useCadStore.getState().loadDocument(project.doc);
      set({ activeMeshDoc: null, activePointCloudDoc: null, currentId: id, currentName: project.meta.name, status: "opened", busy: false });
    }
    // Load the project's AI conversation (messages + generation trace) so the
    // GenerationPanel shows this project's history (SPEC-6 FR-32). Empty if none.
    void useAiStore.getState().openConversation(id);
  },

  save: async () => {
    const { store, currentId, currentName, thumbnail } = get();
    if (!store) return;
    if (!currentId) {
      await get().saveAs(currentName === "Untitled" ? "Untitled" : currentName);
      return;
    }
    set({ status: "saving…" });
    try {
      // Kind-aware: persists the open mesh document when one is active, else the
      // live voxel sculpt, else the parametric document (liveDocument). Mesh and
      // voxel projects get viewport thumbnails exactly like parametric ones — the
      // same canvas shows the mesh (from its GLB) or the sculpt.
      await store.save(currentId, liveDocument(), thumbnail?.() ?? null);
      await get().refresh();
      set({ status: "saved" });
      // The on-disk project is now current → the recovery snapshot is clean. Cancel
      // any pending dirty write so it can't clobber this clean one. A failed clean
      // write still surfaces (the stale dirty snapshot would re-prompt next launch).
      cancelPendingRecovery();
      void writeRecovery({
        doc: toRecoveryDoc(liveDocument()),
        name: currentName,
        currentId,
        dirty: false,
        savedAt: Date.now(),
      }).then(surfaceRecoveryFailure);
    } catch (err) {
      // store.save genuinely rejects — the project row was deleted in another tab
      // (sqlite.ts: getRowsModified() === 0) or IndexedDB `put` hit quota. Every
      // caller invokes save() as `void` (the autosave timer + the Save buttons), so
      // an unguarded rejection would be an unhandled promise: the status line stays
      // stuck on "saving…" forever and the user never learns their work didn't
      // persist. Surface the failure on the only channel the UI reads. Because the
      // clean writeRecovery above never ran, the prior *dirty* snapshot is left
      // intact, so a crash is still recoverable. No re-throw: the status IS the signal.
      set({ status: `save failed — changes not saved (${errMessage(err)})` });
    }
  },

  saveAs: async (name) => {
    const { store, thumbnail } = get();
    if (!store) return;
    set({ status: "saving…" });
    try {
      const doc = liveDocument(); // kind-aware: the live voxel sculpt or the parametric doc
      const meta = await store.create(name, doc);
      // Attach the thumbnail in the same flow.
      await store.save(meta.id, doc, thumbnail?.() ?? null);
      await get().refresh();
      set({ currentId: meta.id, currentName: name, status: "saved" });
      cancelPendingRecovery();
      void writeRecovery({
        doc: toRecoveryDoc(doc),
        name,
        currentId: meta.id,
        dirty: false,
        savedAt: Date.now(),
      }).then(surfaceRecoveryFailure);
    } catch (err) {
      // Same rationale as save(): create/save reject on quota or a backend failure,
      // and the callers invoke saveAs() as `void`. Surface it on the status line and
      // keep the dirty recovery snapshot intact rather than throwing into the void.
      set({ status: `save failed — changes not saved (${errMessage(err)})` });
    }
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
    // Drop the project's saved conversation too (resets memory if it was active).
    void useAiStore.getState().deleteConversation(id);
  },

  recover: () => {
    const snap = get().recoverable;
    if (!snap) return;
    cancelPendingPersistence(); // §2.12.4: the pre-recover document's timers are stale
    set({ busy: true });
    const voxel = voxelOfRecoveryDoc(snap.doc);
    const mesh = meshOfRecoveryDoc(snap.doc);
    const pointCloud = pointCloudOfRecoveryDoc(snap.doc);
    if (voxel) {
      // A crashed voxel sculpt (ADR-0010): reopen it in the voxel store + workspace.
      useVoxelStore.getState().open(voxel);
      syncWorkspace(true);
      set({ activeMeshDoc: null, activePointCloudDoc: null });
    } else if (mesh) {
      // A crashed mesh project (SPEC-6 decision 20): restore it as activeMeshDoc —
      // the viewport re-renders it from its GLB; the parametric editor stays out of
      // the loop, exactly as open() routes a mesh project.
      useVoxelStore.getState().close();
      syncWorkspace(false);
      set({ activeMeshDoc: mesh, activePointCloudDoc: null });
    } else if (pointCloud) {
      // A crashed point-cloud project (SPEC-13): restore it as activePointCloudDoc — the viewport
      // re-renders it as a THREE.Points cloud, exactly as open() routes a cloud project.
      useVoxelStore.getState().close();
      syncWorkspace(false);
      set({ activeMeshDoc: null, activePointCloudDoc: pointCloud });
    } else {
      useVoxelStore.getState().close();
      syncWorkspace(false);
      useCadStore.getState().loadDocument(snap.doc);
      // a stale open mesh/cloud doc must not shadow the recovered editor doc
      set({ activeMeshDoc: null, activePointCloudDoc: null });
    }
    set({
      currentId: snap.currentId,
      currentName: snap.name,
      status: "recovered unsaved work",
      recoverable: null,
      busy: false,
    });
    // Restore the recovered project's conversation (null id → untitled, empty).
    void useAiStore.getState().openConversation(snap.currentId);
    clearRecovery();
  },

  dismissRecovery: () => {
    clearRecovery();
    set({ recoverable: null });
  },
}));
