// The CAD Studio Zustand store (SPEC-5 FR-2): the single source of truth for the
// document (feature tree + params), the typed 3D selection, and UI/status state.
// All mutations are pure, immutable, and deterministic (ids are sequential, no
// RNG/time) so the document round-trips reproducibly (NFR-2). Undo/redo (M2.2)
// and persistence (M5) layer on top of these reducers.

import { create } from "zustand";
import { solveMates, type EdgeRef, type FaceRef, type MateSolveResult } from "@plastiq/cad";
import type { JointKind } from "@plastiq/cad";
import {
  emptyAssembly,
  localToWorld,
  quatRotate,
  reanchorJoints,
  toAssemblyInput,
  worldToLocal,
  IDENTITY_POSE,
  type AssemblyJoint,
  type AssemblyMate,
  type AssemblyModel,
  type ComponentInstance,
  type Quat,
  type Vec3,
} from "../assembly/model.js";
import {
  PLACEMENT_TYPE,
  type CadDocument,
  type EditorFeature,
  type FeatureId,
  type Pick,
  type SelectionMode,
  type Workspace,
} from "./types.js";
import type { SectionAnalysis } from "../viewport/section.js";
import { isIdentityPlacement, placementFromParams } from "../viewport/placement.js";
import {
  DEFAULT_SIM_EXPERIMENT,
  type SimExperimentConfig,
  type SimTelemetry,
} from "../sim/experiments.js";

/** Persistent refs (SPEC-4 FR-16) for the current build's pickable entities,
 * keyed by the transient pick id — the bridge a dress-up feature stores. */
export interface SelectionRefs {
  faces: Record<number, FaceRef>;
  edges: Record<number, EdgeRef>;
}

/** A feature spec to add (id is assigned by the store). */
export type NewFeature = Omit<EditorFeature, "id">;

export interface CadStore {
  // --- document ---
  features: EditorFeature[];
  params: Record<string, number>;
  /** Monotonic id counter (deterministic ids `f1`, `f2`, …). */
  nextSeq: number;

  // --- assembly (M4): component instances of this part + their mates ---
  assembly: AssemblyModel;
  /** Mate authoring mode: clicks pick instance faces (M4.2). Transient UI. */
  mateMode: boolean;
  /** Accumulated mate endpoints (local point + dir on an instance), max 2. */
  matePicks: { instanceId: string; point: Vec3; dir: Vec3 }[];
  /** Latest mate-solve result (verdict / DOF), null before first solve. */
  assemblyResult: MateSolveResult | null;
  /** Transient joint-drive values for the motion preview (FR-36), by joint id. */
  jointDrive: Record<string, number>;
  /** Simulate mode (FR-41): the part is running in the in-browser sim. Transient. */
  simulating: boolean;
  /** Playback (FR-41): sim advancing is paused/frozen. Transient. */
  simPaused: boolean;
  /** Fixed ticks the sim has advanced — drives the elapsed-time readout. Transient. */
  simTicks: number;
  /** Monotonic request tokens for one-shot playback commands issued from the UI
   * and applied by the viewport's sim loop (step one frame / rewind to start). */
  simStepReq: number;
  simRewindReq: number;
  /** Bump to rebuild the sim with the current experiment config (new run). */
  simRestartReq: number;
  /** Physics experiment recipe applied when the sim spawns (drop test, etc.). */
  simExperiment: SimExperimentConfig;
  /** Live telemetry from the running sim (null when not simulating). */
  simTelemetry: SimTelemetry | null;

  // --- undo/redo history (M2.2): snapshots of the document only ---
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // --- selection / UI ---
  selectedFeatureId: FeatureId | null;
  selMode: SelectionMode;
  picks: Pick[];
  status: string;
  /** Active editor workspace (Fusion-style mode). Authority over `simulating`. */
  workspace: Workspace;
  /** A feature being set interactively via the in-viewport value gizmo (drag arrow
   * + value box). `start` is the value at edit-start so Cancel can revert/remove.
   * Transient UI state (not serialized). */
  activeFeatureEdit: { id: FeatureId; param: string; start: number } | null;
  /** Transform-gizmo mode (FR-11): translate or rotate the selected component. */
  gizmoMode: "translate" | "rotate";
  /** Measure tool (FR-13): active flag + latest readout (null when none). */
  measuring: boolean;
  measureResult: string | null;
  /**
   * Every feature that failed the last rebuild → its message (FR-24).
   *
   * A map, not a single id: the rebuild ISOLATES per-feature failures, so more
   * than one feature can be errored at once (and a cascade — a failed sketch
   * plus the extrude that needed it — is the common case). Empty when the last
   * rebuild was clean.
   */
  featureErrors: Record<FeatureId, string>;
  /** Features that BUILT but changed nothing visible (§13.8 P0) — e.g. a join
   * that landed entirely inside the existing body. Not errors: the geometry is
   * valid, but reporting them silently is what made "nothing happened" the
   * product's signature complaint. */
  featureWarnings: Record<FeatureId, string>;
  /** Persistent refs for the current build's pickable faces/edges (FR-16). */
  selectionRefs: SelectionRefs;
  /** Volume + centroid of the current build (mass-properties readout), or null
   *  when the document has no geometry. Density-free; mass needs a material. */
  massProps: { volume: number; com: [number, number, number] } | null;
  /** Section analysis (FR-14 / Fusion-style): clip plane cutting the model, or
   *  null when off. Axis fraction or face-derived plane + optional flip. */
  section: SectionAnalysis | null;
  /** Exploded-view factor (FR-33): instances are spread from the assembly centroid
   *  by this fraction of their offset (0 = assembled). Transient view state. */
  explodeFactor: number;
  /** Interference check (FR-33): clashing instance-id pairs from the last run,
   *  null = not checked yet, [] = checked & clear. Transient view state. */
  interferences: { a: string; b: string }[] | null;
  /** Monotonic token: bumped to request an interference check, run by the viewport. */
  interferenceReq: number;
  /** Rollback bar (FR-25): features at index ≥ this are skipped at rebuild
   * (null = no rollback, build everything). */
  rollbackIndex: number | null;
  /** The id of the feature the rollback bar sits before, so the index can be
   *  re-resolved after features are removed/reordered (CADStudio.md §5.3). */
  rollbackBeforeId: string | null;

  // --- document actions ---
  addFeature: (f: NewFeature) => FeatureId;
  /** Merge `params` into feature `id`. By default pushes one undo snapshot. Pass
   * `{ history: false }` for live writes (mid-drag gizmo ticks) that must fold into a
   * single undo step instead of deep-cloning the doc per frame and flooding history —
   * the feature-edit gizmo carries history only on the first write of a session. */
  updateParams: (
    id: FeatureId,
    params: Record<string, number>,
    opts?: { history?: boolean },
  ) => void;
  setFeatureData: (id: FeatureId, data: Record<string, unknown>) => void;
  /** Rebind feature deps (e.g. sketch binding for extrude/cut/revolve) — C10 Properties. */
  setFeatureDeps: (id: FeatureId, deps: FeatureId[] | undefined) => void;
  renameFeature: (id: FeatureId, name: string) => void;
  removeFeature: (id: FeatureId) => void;
  toggleSuppress: (id: FeatureId) => void;
  /** Move feature `id` to index `to` (clamped); used by drag-reorder (M2.6). */
  reorderFeature: (id: FeatureId, to: number) => void;
  setParam: (name: string, value: number) => void;
  /** Upsert the single body-placement feature (FR-11 gizmo write-back). */
  upsertPlacement: (params: Record<string, number>) => void;
  setGizmoMode: (mode: "translate" | "rotate") => void;
  /** Toggle the measure tool; turning it off clears the readout (FR-13). */
  toggleMeasure: () => void;
  setMeasureResult: (result: string | null) => void;
  /** Replace the failed-feature map from a rebuild's statuses ({} clears it). */
  setFeatureErrors: (errors: Record<FeatureId, string>) => void;
  setFeatureWarnings: (warnings: Record<FeatureId, string>) => void;
  /** Replace the persistent-ref lookup for the current build (FR-16). */
  setSelectionRefs: (refs: SelectionRefs) => void;
  /** Publish the current build's volume + centroid (null when no geometry). */
  setMassProps: (props: { volume: number; com: [number, number, number] } | null) => void;
  /** Enable/adjust the section analysis plane, or disable it (null) (FR-14). */
  setSection: (section: SectionAnalysis | null) => void;
  /** Set the exploded-view factor (0 = assembled) (FR-33). */
  setExplodeFactor: (factor: number) => void;
  /** Request an interference check (the viewport computes + publishes it) (FR-33). */
  checkInterference: () => void;
  /** Publish interference results (clashing pairs, or null to clear) (FR-33). */
  setInterferences: (clashes: { a: string; b: string }[] | null) => void;
  /** Set the rollback point (index, or null to build everything) (FR-25). */
  setRollback: (index: number | null) => void;

  // --- selection actions ---
  selectFeature: (id: FeatureId | null) => void;
  setSelMode: (mode: SelectionMode) => void;
  /** Switch the editor workspace (FR-4 Fusion-style). `simulate` drives the sim
   * flag; the authority over `simulating`. */
  setWorkspace: (w: Workspace) => void;
  /** Begin/end an in-viewport interactive value edit for a feature (drag gizmo). */
  setActiveFeatureEdit: (
    edit: { id: FeatureId; param: string; start: number } | null,
  ) => void;
  /** Add or replace a 3D sub-entity pick (additive = multi-select). */
  pick: (p: Pick, additive?: boolean) => void;
  /** Replace (or, additive, merge) the pick set — the rubber-band box select. */
  setPicks: (picks: Pick[], additive?: boolean) => void;
  clearPicks: () => void;
  setStatus: (status: string) => void;

  // --- assembly actions (M4) ---
  /** Insert a component instance of this part at a pose (default: offset). */
  addInstance: () => string;
  removeInstance: (id: string) => void;
  toggleInstanceFixed: (id: string) => void;
  /** Add a mate and re-solve the assembly poses (M4.2). */
  addMate: (mate: AssemblyMate) => void;
  removeMate: (id: string) => void;
  // --- mate authoring (M4.2) ---
  setMateMode: (on: boolean) => void;
  /** Record a picked instance face (world point + faceId) as a mate endpoint. */
  addMatePick: (pick: { instanceId: string; faceId: number; worldPoint: Vec3 }) => void;
  clearMatePicks: () => void;
  /** Build a mate of `kind` from the two accumulated picks and solve. `value`
   * (SI: metres for distance, radians for angle) is used by the valued kinds. */
  applyMate: (kind: AssemblyMate["kind"], value?: number) => void;
  /** Update a distance/angle mate's scalar (SI) and re-solve the assembly. */
  setMateValue: (id: string, value: number) => void;
  // --- joints (M4.3, design-time) ---
  /** Build a joint of `kind` from the two accumulated picks (parent → child). */
  applyJoint: (kind: JointKind) => void;
  removeJoint: (id: string) => void;
  /** Drive a joint's coordinate for the motion preview (transient) (FR-36). */
  setJointDrive: (id: string, value: number) => void;
  /** Enter/leave Simulate mode (FR-41). */
  setSimulating: (on: boolean) => void;
  /** Pause/resume the running sim (FR-41 playback). */
  setSimPaused: (on: boolean) => void;
  /** Display: record ticks advanced (written by the viewport sim loop). */
  setSimTicks: (ticks: number) => void;
  /** Request a one-frame advance while paused (applied by the viewport). */
  requestSimStep: () => void;
  /** Request a rewind to the start (applied by the viewport). */
  requestSimRewind: () => void;
  /** Request a full sim rebuild with the current experiment config. */
  requestSimRestart: () => void;
  /** Patch the physics experiment recipe (drop height, gravity, …). */
  setSimExperiment: (patch: Partial<SimExperimentConfig>) => void;
  /** Publish live experiment telemetry (viewport → UI). */
  setSimTelemetry: (t: SimTelemetry | null) => void;
  /** Re-solve the mate network, writing solved poses back as the new seed. */
  solveAssembly: () => void;

  // --- undo / redo (M2.2) ---
  undo: () => void;
  redo: () => void;

  // --- document I/O (persistence M5 / reproducible reload) ---
  toDocument: () => CadDocument;
  /** Replace the whole document, WIPING undo/redo — for OPENING a project or a
   * reload/recovery, where the prior in-memory history is meaningless. */
  loadDocument: (doc: CadDocument) => void;
  /** Replace the whole document but PRESERVE undo history: snapshots the current
   * document onto the undo stack first, so the swap is a single undoable step
   * (§2.12.1). Used by AI/ML applies mid-session — accepting an AI edit must not
   * make an hour of prior manual edits un-undoable. */
  replaceDocument: (doc: CadDocument) => void;
  reset: () => void;
}

/** Max retained undo steps. */
const HISTORY_LIMIT = 100;

/**
 * A history snapshot: the document (features + params + assembly) PLUS the id
 * counter, so undo/redo restore `nextSeq` too — otherwise re-creating a feature
 * after an undo skips ids (CADStudio.md §5.2).
 */
export interface HistorySnapshot {
  features: EditorFeature[];
  params: Record<string, number>;
  assembly: AssemblyModel;
  nextSeq: number;
  /** The derived mate-solve verdict/DOF/poses, captured so undo/redo restore it in
   * lock-step with `assembly` (it is NOT re-solved on undo, so without this the
   * MATES readout would show a stale verdict after undoing an assembly edit). */
  assemblyResult: MateSolveResult | null;
}

function snapshot(s: {
  features: EditorFeature[];
  params: Record<string, number>;
  assembly: AssemblyModel;
  nextSeq: number;
  assemblyResult: MateSolveResult | null;
}): HistorySnapshot {
  return structuredClone({
    features: s.features,
    params: s.params,
    assembly: s.assembly,
    nextSeq: s.nextSeq,
    assemblyResult: s.assemblyResult,
  });
}

/** History patch to merge into a mutating `set`: push the prior doc, drop redo. */
/**
 * §2.11.4: a document mutation while a sim runs invalidates the running world —
 * it was built from the pre-edit document, so its manifest/colliders are stale.
 * Auto-stop with a status note saying why, mirroring exactly what the Stop
 * action sets (`setSimulating(false)`: sim off, unpaused, ticks reset, telemetry
 * cleared). The workspace is deliberately KEPT — the user stays on the Simulate
 * tab and can rerun against the edited document. No-op when not simulating.
 */
function stopStaleSim(s: CadStore): Partial<CadStore> {
  if (!s.simulating) return {};
  return {
    simulating: false,
    simPaused: false,
    simTicks: 0,
    simTelemetry: null,
    status: "simulation stopped — the document changed (press Simulate to rerun)",
  };
}

function pushHistory(
  s: CadStore,
): { past: HistorySnapshot[]; future: HistorySnapshot[] } & Partial<CadStore> {
  // Every history-pushing mutation edits the document, so it also stops (and
  // annotates) a running sim — the §2.11.4 invalidation rides the same choke
  // point the undo stack does.
  return { past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT), future: [], ...stopStaleSim(s) };
}

/**
 * The non-history state fields for loading a document: a deep-cloned features /
 * params / assembly, `nextSeq` re-derived from EVERY typed id minted off the
 * shared counter (features `f<n>`, instances `i<n>`, mates `m<n>`, joints `j<n>` —
 * missing the mate/joint prefixes would let a reloaded assembly reissue a
 * colliding id), and the transient selection/rollback reset. Shared by
 * `loadDocument` (which then WIPES history) and `replaceDocument` (which
 * PRESERVES it) so the two can never diverge on how a doc is loaded.
 */
function docLoadState(doc: CadDocument) {
  const ids = [
    ...doc.features.map((f) => f.id),
    ...(doc.assembly?.instances ?? []).map((i) => i.id),
    ...(doc.assembly?.mates ?? []).map((m) => m.id),
    ...(doc.assembly?.joints ?? []).map((j) => j.id),
  ];
  const maxSeq = ids.reduce((m, id) => {
    const n = /^[fimj](\d+)$/.exec(id);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  const a = doc.assembly;
  const assembly: AssemblyModel = a
    ? { instances: a.instances, mates: a.mates, joints: a.joints ?? [] }
    : emptyAssembly();
  const cloned = structuredClone({ features: doc.features, params: doc.params, assembly });
  return {
    features: cloned.features,
    params: cloned.params,
    assembly: cloned.assembly,
    nextSeq: maxSeq + 1,
    jointDrive: {},
    selectedFeatureId: null,
    picks: [],
    rollbackIndex: null,
    rollbackBeforeId: null,
  };
}

function defaultName(type: string, seq: number): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return `${label} ${seq}`;
}

const samePick = (a: Pick, b: Pick): boolean => a.kind === b.kind && a.id === b.id;

/** Re-resolve the rollback bar's index from its anchor feature id (FR-25 / §5.3). */
function reconcileRollback(features: EditorFeature[], anchorId: string | null): number | null {
  if (anchorId === null) return null;
  const idx = features.findIndex((f) => f.id === anchorId);
  return idx >= 0 ? idx : null;
}

/** The store's data fields (everything in CadStore that isn't an action).
 * Mapped by hand (not TS `Pick` — this module shadows that name with the
 * selection Pick type). */
type CadStateKey =
  | "features"
  | "params"
  | "nextSeq"
  | "assembly"
  | "mateMode"
  | "matePicks"
  | "assemblyResult"
  | "jointDrive"
  | "simulating"
  | "simPaused"
  | "simTicks"
  | "simStepReq"
  | "simRewindReq"
  | "simRestartReq"
  | "simExperiment"
  | "simTelemetry"
  | "past"
  | "future"
  | "selectedFeatureId"
  | "selMode"
  | "picks"
  | "status"
  | "workspace"
  | "activeFeatureEdit"
  | "gizmoMode"
  | "measuring"
  | "measureResult"
  | "featureErrors"
  | "featureWarnings"
  | "selectionRefs"
  | "massProps"
  | "section"
  | "explodeFactor"
  | "interferences"
  | "interferenceReq"
  | "rollbackIndex"
  | "rollbackBeforeId";
type CadState = { [K in CadStateKey]: CadStore[K] };

/** One authority for the store's initial data state: `create` seeds from it and
 * `reset()` restores it, so the two can never drift apart (Review #23). A fresh
 * object per call — `assembly`/`selectionRefs` are mutable containers. */
function initialCadState(): CadState {
  return {
    features: [],
    params: {},
    nextSeq: 1,
    assembly: emptyAssembly(),
    mateMode: false,
    matePicks: [],
    assemblyResult: null,
    jointDrive: {},
    simulating: false,
    simPaused: false,
    simTicks: 0,
    simStepReq: 0,
    simRewindReq: 0,
    simRestartReq: 0,
    simExperiment: { ...DEFAULT_SIM_EXPERIMENT },
    simTelemetry: null,
    past: [],
    future: [],
    selectedFeatureId: null,
    selMode: "face",
    picks: [],
    status: "loading",
    workspace: "design",
    activeFeatureEdit: null,
    gizmoMode: "translate",
    measuring: false,
    measureResult: null,
    featureErrors: {},
    featureWarnings: {},
    selectionRefs: { faces: {}, edges: {} },
    massProps: null,
    section: null,
    explodeFactor: 0,
    interferences: null,
    interferenceReq: 0,
    rollbackIndex: null,
    rollbackBeforeId: null,
  };
}

export const useCadStore = create<CadStore>((set, get) => ({
  ...initialCadState(),

  addFeature: (f) => {
    const seq = get().nextSeq;
    const id = `f${seq}`;
    const feature: EditorFeature = { ...f, id, name: f.name ?? defaultName(f.type, seq) };
    set((s) => ({
      ...pushHistory(s),
      features: [...s.features, feature],
      nextSeq: s.nextSeq + 1,
      selectedFeatureId: id,
    }));
    return id;
  },

  updateParams: (id, params, opts) =>
    set((s) => ({
      // history:false (live drags) still MUTATES the document — it must stop a
      // running sim (§2.11.4) even though it skips the undo snapshot.
      ...(opts?.history === false ? stopStaleSim(s) : pushHistory(s)),
      features: s.features.map((f) =>
        f.id === id ? { ...f, params: { ...f.params, ...params } } : f,
      ),
    })),

  setFeatureData: (id, data) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) => (f.id === id ? { ...f, data: { ...f.data, ...data } } : f)),
    })),

  setFeatureDeps: (id, deps) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) =>
        f.id === id ? { ...f, deps: deps && deps.length > 0 ? deps : undefined } : f,
      ),
    })),

  renameFeature: (id, name) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) => (f.id === id ? { ...f, name } : f)),
    })),

  removeFeature: (id) =>
    set((s) => {
      const features = s.features.filter((f) => f.id !== id);
      return {
        ...pushHistory(s),
        features,
        selectedFeatureId: s.selectedFeatureId === id ? null : s.selectedFeatureId,
        activeFeatureEdit: s.activeFeatureEdit?.id === id ? null : s.activeFeatureEdit,
        rollbackIndex: reconcileRollback(features, s.rollbackBeforeId),
      };
    }),

  toggleSuppress: (id) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) => (f.id === id ? { ...f, suppressed: !f.suppressed } : f)),
    })),

  reorderFeature: (id, to) =>
    set((s) => {
      const from = s.features.findIndex((f) => f.id === id);
      if (from < 0) return {};
      const next = s.features.slice();
      const [moved] = next.splice(from, 1);
      const clamped = Math.max(0, Math.min(to, next.length));
      next.splice(clamped, 0, moved!);
      return {
        ...pushHistory(s),
        features: next,
        rollbackIndex: reconcileRollback(next, s.rollbackBeforeId),
      };
    }),

  setParam: (name, value) =>
    set((s) => ({ ...pushHistory(s), params: { ...s.params, [name]: value } })),

  upsertPlacement: (params) =>
    set((s) => {
      const existing = s.features.find((f) => f.type === PLACEMENT_TYPE);
      if (existing) {
        return {
          ...pushHistory(s),
          features: s.features.map((f) =>
            f.id === existing.id ? { ...f, params: { ...f.params, ...params } } : f,
          ),
        };
      }
      // Nothing placed yet AND the pose is identity: the gizmo fires this on every
      // mouse-up, including a click that moved nothing, so creating a feature here
      // would put a no-op "Placement" in the tree, burn an undo step that undoes
      // nothing visible, and persist/export a pose that says the part is where it
      // already is. An EXISTING placement is still written above — returning a
      // moved body to the origin is a real change.
      if (isIdentityPlacement(placementFromParams(params))) return {};
      const seq = s.nextSeq;
      const feature: EditorFeature = {
        id: `f${seq}`,
        type: PLACEMENT_TYPE,
        name: "Placement",
        params,
      };
      return { ...pushHistory(s), features: [...s.features, feature], nextSeq: seq + 1 };
    }),

  setGizmoMode: (mode) => set({ gizmoMode: mode }),

  toggleMeasure: () =>
    set((s) => ({ measuring: !s.measuring, measureResult: s.measuring ? null : s.measureResult })),
  setMeasureResult: (result) => set({ measureResult: result }),
  setFeatureErrors: (errors) => set({ featureErrors: errors }),
  setFeatureWarnings: (warnings) => set({ featureWarnings: warnings }),
  setSelectionRefs: (refs) => set({ selectionRefs: refs }),

  setMassProps: (props) => set({ massProps: props }),

  setSection: (section) => set({ section }),

  setExplodeFactor: (factor) => set({ explodeFactor: Math.max(0, factor) }),

  checkInterference: () => set((s) => ({ interferenceReq: s.interferenceReq + 1 })),
  setInterferences: (clashes) => set({ interferences: clashes }),
  setRollback: (index) =>
    set((s) => ({
      rollbackIndex: index,
      rollbackBeforeId: index === null ? null : (s.features[index]?.id ?? null),
      // The rollback bar changes which features BUILD — a running sim's world no
      // longer matches, exactly like an edit (§2.11.4), even though rollback is
      // view state and pushes no history.
      ...stopStaleSim(s),
    })),

  selectFeature: (id) => set({ selectedFeatureId: id }),
  setSelMode: (mode) => set({ selMode: mode }),

  // The workspace is the single authority over sim mode: entering `simulate`
  // starts a fresh playing run, leaving stops it (mirrors setSimulating). Sketch
  // mode is a contextual env handled in the UI, not a workspace.
  setWorkspace: (w) =>
    set({
      workspace: w,
      simulating: w === "simulate",
      simPaused: false,
      simTicks: 0,
      simTelemetry: null,
    }),

  setActiveFeatureEdit: (edit) => set({ activeFeatureEdit: edit }),

  pick: (p, additive = false) =>
    set((s) => {
      if (!additive) return { picks: [p] };
      const exists = s.picks.some((q) => samePick(q, p));
      return { picks: exists ? s.picks.filter((q) => !samePick(q, p)) : [...s.picks, p] };
    }),

  setPicks: (picks, additive = false) =>
    set((s) => {
      if (!additive) return { picks };
      const merged = [...s.picks];
      for (const p of picks) if (!merged.some((q) => samePick(q, p))) merged.push(p);
      return { picks: merged };
    }),

  clearPicks: () => set({ picks: [] }),
  setStatus: (status) => set({ status }),

  addInstance: () => {
    const seq = get().nextSeq;
    const id = `i${seq}`;
    // First instance anchors at the origin (the assembly's ground); later ones
    // start offset along +X so they're visible and the solver has room to move.
    const count = get().assembly.instances.length;
    const instance: ComponentInstance = {
      id,
      name: `Part ${count + 1}`,
      fixed: count === 0,
      pose: {
        position: [count * 0.08, 0, 0],
        orientation: [...IDENTITY_POSE.orientation],
      },
    };
    set((s) => ({
      ...pushHistory(s),
      assembly: { ...s.assembly, instances: [...s.assembly.instances, instance] },
      nextSeq: s.nextSeq + 1,
    }));
    return id;
  },

  removeInstance: (id) => {
    set((s) => ({
      ...pushHistory(s),
      assembly: {
        instances: s.assembly.instances.filter((i) => i.id !== id),
        // Drop mates + joints referencing the removed instance.
        mates: s.assembly.mates.filter((m) => m.a.instance !== id && m.b.instance !== id),
        joints: s.assembly.joints.filter((j) => j.parent !== id && j.child !== id),
      },
    }));
    // Re-solve so the remaining instances settle under the changed constraints
    // (consistent with addMate/removeMate; CADStudio.md §5.4).
    get().solveAssembly();
  },

  toggleInstanceFixed: (id) => {
    set((s) => ({
      ...pushHistory(s),
      assembly: {
        ...s.assembly,
        instances: s.assembly.instances.map((i) => (i.id === id ? { ...i, fixed: !i.fixed } : i)),
      },
    }));
    // Grounding/un-grounding an instance changes which poses are free to move.
    get().solveAssembly();
  },

  addMate: (mate) => {
    set((s) => ({
      ...pushHistory(s),
      assembly: { ...s.assembly, mates: [...s.assembly.mates, mate] },
    }));
    get().solveAssembly();
  },

  removeMate: (id) => {
    set((s) => ({
      ...pushHistory(s),
      assembly: { ...s.assembly, mates: s.assembly.mates.filter((m) => m.id !== id) },
    }));
    get().solveAssembly();
  },

  setMateMode: (on) => set({ mateMode: on, matePicks: [] }),

  addMatePick: ({ instanceId, faceId, worldPoint }) => {
    const s = get();
    const inst = s.assembly.instances.find((i) => i.id === instanceId);
    const ref = s.selectionRefs.faces[faceId];
    if (!inst || !ref) return;
    // World hit point → instance-local point; the face normal is already local
    // (shared part geometry), giving the mate endpoint's point + direction.
    const point = worldToLocal(inst.pose, worldPoint);
    const dir = ref.normal as Vec3;
    set((st) => ({ matePicks: [...st.matePicks, { instanceId, point, dir }].slice(-2) }));
  },

  clearMatePicks: () => set({ matePicks: [] }),

  applyMate: (kind, value = 0) => {
    const { matePicks } = get();
    if (matePicks.length !== 2) return;
    const [p0, p1] = matePicks;
    const a = { instance: p0!.instanceId, point: p0!.point, dir: p0!.dir };
    const b = { instance: p1!.instanceId, point: p1!.point, dir: p1!.dir };
    const id = `m${get().nextSeq}`;
    // distance/angle carry a scalar (SI: metres / radians); the others don't.
    const mate: AssemblyMate =
      kind === "distance"
        ? { id, kind, a, b, value }
        : kind === "angle"
          ? { id, kind, a, b, value }
          : { id, kind, a, b };
    // Push history, bump nextSeq, and add the mate in ONE set (like applyJoint) so
    // the snapshot captures the PRE-increment seq. The previous split — a separate
    // nextSeq++ set, then addMate's own history push — captured the post-increment
    // seq, so undo + re-apply skipped the `m<n>` id. Then re-solve, as addMate does.
    set((st) => ({
      ...pushHistory(st),
      nextSeq: st.nextSeq + 1,
      matePicks: [],
      assembly: { ...st.assembly, mates: [...st.assembly.mates, mate] },
    }));
    get().solveAssembly();
  },

  setMateValue: (id, value) => {
    set((s) => ({
      ...pushHistory(s),
      assembly: {
        ...s.assembly,
        mates: s.assembly.mates.map((m) =>
          m.id === id && (m.kind === "distance" || m.kind === "angle") ? { ...m, value } : m,
        ),
      },
    }));
    // Changing the target distance/angle re-poses the assembly.
    get().solveAssembly();
  },

  applyJoint: (kind) => {
    const s = get();
    if (s.matePicks.length !== 2) return;
    const [p0, p1] = s.matePicks;
    const parentInst = s.assembly.instances.find((i) => i.id === p0!.instanceId);
    if (!parentInst) return;
    // The joint frame lives in world coords: origin = the parent pick point, axis
    // = the parent face normal, both transformed out of the parent's local frame.
    const origin = localToWorld(parentInst.pose, p0!.point);
    const axis = quatRotate(parentInst.pose.orientation, p0!.dir);
    const id = `j${s.nextSeq}`;
    const joint: AssemblyJoint = {
      id,
      kind,
      parent: p0!.instanceId,
      child: p1!.instanceId,
      origin,
      axis,
    };
    set((st) => ({
      ...pushHistory(st),
      nextSeq: st.nextSeq + 1,
      matePicks: [],
      assembly: { ...st.assembly, joints: [...st.assembly.joints, joint] },
    }));
  },

  removeJoint: (id) =>
    set((st) => {
      const drive = Object.fromEntries(Object.entries(st.jointDrive).filter(([k]) => k !== id));
      return {
        ...pushHistory(st),
        jointDrive: drive,
        assembly: { ...st.assembly, joints: st.assembly.joints.filter((j) => j.id !== id) },
      };
    }),

  setJointDrive: (id, value) => set((st) => ({ jointDrive: { ...st.jointDrive, [id]: value } })),

  // Entering or leaving Simulate always starts from a clean, playing, t=0 state.
  setSimulating: (on) =>
    set({ simulating: on, simPaused: false, simTicks: 0, simTelemetry: on ? null : null }),
  setSimPaused: (on) => set({ simPaused: on }),
  setSimTicks: (ticks) => set({ simTicks: ticks }),
  requestSimStep: () => set((s) => ({ simStepReq: s.simStepReq + 1 })),
  requestSimRewind: () => set((s) => ({ simRewindReq: s.simRewindReq + 1 })),
  requestSimRestart: () => set((s) => ({ simRestartReq: s.simRestartReq + 1 })),
  setSimExperiment: (patch) =>
    set((s) => ({
      simExperiment: { ...s.simExperiment, ...patch },
      // Changing the recipe while simulating rebuilds the world.
      simRestartReq: s.simulating ? s.simRestartReq + 1 : s.simRestartReq,
    })),
  setSimTelemetry: (t) => set({ simTelemetry: t }),

  solveAssembly: () => {
    const { assembly } = get();
    if (assembly.instances.length === 0) return;
    const input = toAssemblyInput(assembly);
    const result = solveMates(input.components, input.mates);
    // Write solved poses back as the new seed (mirrors the sketch solve).
    set((s) => {
      const instances: ComponentInstance[] = s.assembly.instances.map((inst, i) => {
        const p = result.poses[i];
        return p
          ? {
              ...inst,
              pose: {
                position: [...p.position] as Vec3,
                orientation: [...p.orientation] as Quat,
              },
            }
          : inst;
      });
      return {
        assemblyResult: result,
        assembly: {
          ...s.assembly,
          instances,
          // §2.11.5: joint frames are world coords baked from the parent's pose
          // at creation — when the solve re-poses the parent, the frame rides
          // along, so lowered constraints attach where the parts actually are.
          joints: reanchorJoints(s.assembly.joints, s.assembly.instances, instances),
        },
      };
    });
  },

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      const features = structuredClone(prev.features);
      // The rollback bar's index isn't part of history (it's view state); keep it
      // anchored to its feature id across the restore, exactly as remove/reorder
      // do — otherwise undo leaves rollbackIndex pointing at the wrong feature and
      // the build path slices the wrong subtree (wrong geometry).
      const rollbackIndex = reconcileRollback(features, s.rollbackBeforeId);
      return {
        features,
        params: structuredClone(prev.params),
        assembly: structuredClone(prev.assembly ?? emptyAssembly()),
        nextSeq: prev.nextSeq,
        assemblyResult: structuredClone(prev.assemblyResult ?? null),
        rollbackIndex,
        rollbackBeforeId: rollbackIndex === null ? null : s.rollbackBeforeId,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
        // Undoing mid-sim swaps the document out from under the running world.
        ...stopStaleSim(s),
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      const features = structuredClone(next.features);
      const rollbackIndex = reconcileRollback(features, s.rollbackBeforeId);
      return {
        features,
        params: structuredClone(next.params),
        assembly: structuredClone(next.assembly ?? emptyAssembly()),
        nextSeq: next.nextSeq,
        assemblyResult: structuredClone(next.assemblyResult ?? null),
        rollbackIndex,
        rollbackBeforeId: rollbackIndex === null ? null : s.rollbackBeforeId,
        past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        // Redo is a document mutation like any other for a running sim.
        ...stopStaleSim(s),
      };
    }),

  toDocument: () => {
    const { features, params, assembly } = get();
    // Deep copy so a caller mutating the exported doc can't touch live state.
    return structuredClone({ features, params, assembly }) as CadDocument;
  },

  loadDocument: (doc) =>
    // Opening/recovering a project mid-sim would leave the old world playing over
    // a different document — stop it with the note (§2.11.4).
    set((s) => ({ ...docLoadState(doc), past: [], future: [], ...stopStaleSim(s) })),

  replaceDocument: (doc) => {
    // Preserve undo (§2.12.1): snapshot the CURRENT document onto the undo stack
    // BEFORE swapping, so accepting this (AI/ML) edit is a single undoable step
    // instead of erasing every prior manual edit. future is cleared — a new edit
    // invalidates redo, exactly like any other mutation. pushHistory also stops
    // a running sim (§2.11.4) — an AI apply mid-sim invalidates the world too.
    const s = get();
    set({ ...docLoadState(doc), ...pushHistory(s) });
  },

  // Restore the initial data state, keeping the user's selection-mode choice
  // (reset() has always merged around selMode; face/edge/vertex is a UI
  // preference, not document state).
  reset: () => set({ ...initialCadState(), selMode: get().selMode }),
}));
