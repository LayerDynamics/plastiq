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
  toAssemblyInput,
  worldToLocal,
  IDENTITY_POSE,
  type AssemblyJoint,
  type AssemblyMate,
  type AssemblyModel,
  type ComponentInstance,
  type Vec3,
} from "../assembly/model.js";
import {
  PLACEMENT_TYPE,
  type CadDocument,
  type EditorFeature,
  type FeatureId,
  type Pick,
  type SelectionMode,
} from "./types.js";

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

  // --- undo/redo history (M2.2): snapshots of the document only ---
  past: HistorySnapshot[];
  future: HistorySnapshot[];

  // --- selection / UI ---
  selectedFeatureId: FeatureId | null;
  selMode: SelectionMode;
  picks: Pick[];
  status: string;
  /** Transform-gizmo mode (FR-11): translate or rotate the selected component. */
  gizmoMode: "translate" | "rotate";
  /** Measure tool (FR-13): active flag + latest readout (null when none). */
  measuring: boolean;
  measureResult: string | null;
  /** Id of the feature that failed the last rebuild (errored badge), or null. */
  errorFeatureId: FeatureId | null;
  /** Persistent refs for the current build's pickable faces/edges (FR-16). */
  selectionRefs: SelectionRefs;
  /** Rollback bar (FR-25): features at index ≥ this are skipped at rebuild
   * (null = no rollback, build everything). */
  rollbackIndex: number | null;
  /** The id of the feature the rollback bar sits before, so the index can be
   *  re-resolved after features are removed/reordered (CADStudio.md §5.3). */
  rollbackBeforeId: string | null;

  // --- document actions ---
  addFeature: (f: NewFeature) => FeatureId;
  updateParams: (id: FeatureId, params: Record<string, number>) => void;
  setFeatureData: (id: FeatureId, data: Record<string, unknown>) => void;
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
  /** Record the feature that failed the last rebuild (null clears it). */
  setErrorFeature: (id: FeatureId | null) => void;
  /** Replace the persistent-ref lookup for the current build (FR-16). */
  setSelectionRefs: (refs: SelectionRefs) => void;
  /** Set the rollback point (index, or null to build everything) (FR-25). */
  setRollback: (index: number | null) => void;

  // --- selection actions ---
  selectFeature: (id: FeatureId | null) => void;
  setSelMode: (mode: SelectionMode) => void;
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
  /** Build a mate of `kind` from the two accumulated picks and solve. */
  applyMate: (kind: AssemblyMate["kind"]) => void;
  // --- joints (M4.3, design-time) ---
  /** Build a joint of `kind` from the two accumulated picks (parent → child). */
  applyJoint: (kind: JointKind) => void;
  removeJoint: (id: string) => void;
  /** Drive a joint's coordinate for the motion preview (transient) (FR-36). */
  setJointDrive: (id: string, value: number) => void;
  /** Enter/leave Simulate mode (FR-41). */
  setSimulating: (on: boolean) => void;
  /** Re-solve the mate network, writing solved poses back as the new seed. */
  solveAssembly: () => void;

  // --- undo / redo (M2.2) ---
  undo: () => void;
  redo: () => void;

  // --- document I/O (persistence M5 / reproducible reload) ---
  toDocument: () => CadDocument;
  loadDocument: (doc: CadDocument) => void;
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
}

function snapshot(s: {
  features: EditorFeature[];
  params: Record<string, number>;
  assembly: AssemblyModel;
  nextSeq: number;
}): HistorySnapshot {
  return structuredClone({
    features: s.features,
    params: s.params,
    assembly: s.assembly,
    nextSeq: s.nextSeq,
  });
}

/** History patch to merge into a mutating `set`: push the prior doc, drop redo. */
function pushHistory(s: CadStore): { past: HistorySnapshot[]; future: HistorySnapshot[] } {
  return { past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT), future: [] };
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

export const useCadStore = create<CadStore>((set, get) => ({
  features: [],
  params: {},
  nextSeq: 1,
  assembly: emptyAssembly(),
  mateMode: false,
  matePicks: [],
  assemblyResult: null,
  jointDrive: {},
  simulating: false,
  past: [],
  future: [],
  selectedFeatureId: null,
  selMode: "face",
  picks: [],
  status: "loading",
  gizmoMode: "translate",
  measuring: false,
  measureResult: null,
  errorFeatureId: null,
  selectionRefs: { faces: {}, edges: {} },
  rollbackIndex: null,
  rollbackBeforeId: null,

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

  updateParams: (id, params) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) =>
        f.id === id ? { ...f, params: { ...f.params, ...params } } : f,
      ),
    })),

  setFeatureData: (id, data) =>
    set((s) => ({
      ...pushHistory(s),
      features: s.features.map((f) => (f.id === id ? { ...f, data: { ...f.data, ...data } } : f)),
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
  setErrorFeature: (id) => set({ errorFeatureId: id }),
  setSelectionRefs: (refs) => set({ selectionRefs: refs }),
  setRollback: (index) =>
    set((s) => ({
      rollbackIndex: index,
      rollbackBeforeId: index === null ? null : (s.features[index]?.id ?? null),
    })),

  selectFeature: (id) => set({ selectedFeatureId: id }),
  setSelMode: (mode) => set({ selMode: mode, picks: [] }),

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

  applyMate: (kind) => {
    const { matePicks } = get();
    if (matePicks.length !== 2) return;
    const [p0, p1] = matePicks;
    const a = { instance: p0!.instanceId, point: p0!.point, dir: p0!.dir };
    const b = { instance: p1!.instanceId, point: p1!.point, dir: p1!.dir };
    const id = `m${get().nextSeq}`;
    set((st) => ({ nextSeq: st.nextSeq + 1, matePicks: [] }));
    const mate: AssemblyMate =
      kind === "distance"
        ? { id, kind, a, b, value: 0 }
        : kind === "angle"
          ? { id, kind, a, b, value: 0 }
          : { id, kind, a, b };
    get().addMate(mate);
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

  setSimulating: (on) => set({ simulating: on }),

  solveAssembly: () => {
    const { assembly } = get();
    if (assembly.instances.length === 0) return;
    const input = toAssemblyInput(assembly);
    const result = solveMates(input.components, input.mates);
    // Write solved poses back as the new seed (mirrors the sketch solve).
    set((s) => ({
      assemblyResult: result,
      assembly: {
        ...s.assembly,
        instances: s.assembly.instances.map((inst, i) => {
          const p = result.poses[i];
          return p
            ? { ...inst, pose: { position: [...p.position], orientation: [...p.orientation] } }
            : inst;
        }),
      },
    }));
  },

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return {};
      return {
        features: structuredClone(prev.features),
        params: structuredClone(prev.params),
        assembly: structuredClone(prev.assembly ?? emptyAssembly()),
        nextSeq: prev.nextSeq,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return {};
      return {
        features: structuredClone(next.features),
        params: structuredClone(next.params),
        assembly: structuredClone(next.assembly ?? emptyAssembly()),
        nextSeq: next.nextSeq,
        past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
      };
    }),

  toDocument: () => {
    const { features, params, assembly } = get();
    // Deep copy so a caller mutating the exported doc can't touch live state.
    return structuredClone({ features, params, assembly }) as CadDocument;
  },

  loadDocument: (doc) => {
    // Re-derive nextSeq from EVERY typed id minted off the shared counter —
    // features `f<n>`, instances `i<n>`, mates `m<n>`, joints `j<n>`. Missing the
    // mate/joint prefixes here let a reloaded assembly reissue a colliding id.
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
    set({
      features: cloned.features,
      params: cloned.params,
      assembly: cloned.assembly,
      nextSeq: maxSeq + 1,
      jointDrive: {},
      past: [],
      future: [],
      selectedFeatureId: null,
      picks: [],
      rollbackIndex: null,
      rollbackBeforeId: null,
    });
  },

  reset: () =>
    set({
      features: [],
      params: {},
      nextSeq: 1,
      assembly: emptyAssembly(),
      mateMode: false,
      matePicks: [],
      assemblyResult: null,
      jointDrive: {},
      simulating: false,
      past: [],
      future: [],
      selectedFeatureId: null,
      picks: [],
      status: "loading",
      gizmoMode: "translate",
      measuring: false,
      measureResult: null,
      errorFeatureId: null,
      selectionRefs: { faces: {}, edges: {} },
      rollbackIndex: null,
      rollbackBeforeId: null,
    }),
}));
