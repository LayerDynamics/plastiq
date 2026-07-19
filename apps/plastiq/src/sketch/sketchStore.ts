// Transient sketch-editing state (SPEC-5 M3 / ADR-0014). Kept OUT of the document
// store and its undo/redo: entering a sketch is a session state, not a document
// mutation (sketch-session principle). Finish commits the constrained model into
// the `sketch` feature's data; the constraint solve runs HERE on the main thread
// (the kernel solveSketch is pure TS, no OCCT) so dragging re-solves live without
// a worker round-trip. Drawing is 3D in-place (SketchScene); this store is the
// parametric source of truth.

import { create } from "zustand";
import { solveSketch, type DatumPlane, type SolveResult } from "@plastiq/cad";
import { centeredView, type View2D } from "./transform2d.js";
import { buildConstraints, type ConstraintKind } from "./hit.js";
import { buildDimension, measure, type DimensionKind } from "./dim.js";
import type { InferredConstraint } from "./infer.js";
import {
  arcMidpoint,
  circumcircle,
  emptySketch,
  perpDistance,
  projectToCircle,
  regularPolygonVertices,
  slotOutline,
  toSolverInput,
  type DatumPlaneId,
  type SketchConstraint,
  type SketchEntity,
  type SketchModel,
  type SketchPoint,
} from "./model.js";

export type SketchTool =
  | "select"
  | "line"
  | "rectangle"
  | "rectCenter"
  | "circle"
  | "circle3"
  | "arc3"
  | "arcCenter"
  | "polygon"
  | "slot"
  | "spline"
  | "point";

/** Feature-driven sketch session (ADR-0014): Finish commits sketch + this feature. */
export type SketchConsumer =
  | { type: "extrude"; params: Record<string, number>; data?: Record<string, unknown> }
  | { type: "cut"; params: Record<string, number>; data?: Record<string, unknown> }
  | { type: "revolve"; params: Record<string, number>; data?: Record<string, unknown> };

export interface SketchStore {
  active: boolean;
  /**
   * The active sketch's plane RESOLVED to a world frame, or null when not
   * sketching (and briefly while a face plane is still resolving).
   *
   * A base datum resolves synchronously, but a FACE plane needs the solid, so
   * the viewport resolves it through the geometry worker and publishes the
   * result here. Keeping it in the store is what lets 3D overlays (the plane
   * gizmo) draw a face-based sketch plane at all — they cannot run OCCT
   * themselves, and recomputing it per-consumer would duplicate the round trip.
   */
  resolvedFrame: DatumPlane | null;
  /** The document feature being edited (null = a brand-new sketch). */
  editingFeatureId: string | null;
  /** When set, Finish also adds this solid feature consuming the new sketch (W4). */
  consumer: SketchConsumer | null;
  model: SketchModel;
  view: View2D;
  tool: SketchTool;
  /** Point ids accumulated mid-gesture (line chain start, rect/circle anchor). */
  pending: string[];
  /** New entities are construction (excluded from the profile) when true. */
  construction: boolean;
  /** Side count for the regular-polygon tool (FR-16). */
  polygonSides: number;
  /** Latest constraint-solve result (DOF / verdict), null before first solve. */
  result: SolveResult | null;
  /** Selected sketch entity/point ids (for select-then-constrain). */
  selection: string[];
  /** Id of the dimension constraint whose value is being edited (FR-19). */
  editingDim: string | null;
  /** True once the planegcs solver wasm has loaded — sketching is gated on it so
   * the synchronous `solveSketch` never races the (small, fast) wasm load (FR). */
  solverReady: boolean;
  /** Sketch-local undo/redo stacks of model snapshots (transient; never persisted
   * and separate from the document store's history per ADR-0013). */
  past: SketchModel[];
  future: SketchModel[];
  /** Mark the solver ready (called when initSketchSolver resolves). */
  setSolverReady: (ready: boolean) => void;
  /** Publish the resolved world frame of the active sketch plane (viewport). */
  setResolvedFrame: (frame: DatumPlane | null) => void;

  enterSketch: (
    plane: DatumPlaneId,
    offset?: number,
    featureId?: string,
    model?: SketchModel,
    consumer?: SketchConsumer | null,
  ) => void;
  exitSketch: () => void;
  setView: (view: View2D) => void;
  setTool: (tool: SketchTool) => void;
  setConstruction: (on: boolean) => void;
  setPolygonSides: (n: number) => void;

  addPoint: (p: Omit<SketchPoint, "id">) => string;
  addEntity: (e: SketchEntity) => void;
  addConstraint: (c: SketchConstraint) => void;
  /** Apply a select-then-constrain constraint to the current selection (M3.4). */
  applyConstraint: (kind: ConstraintKind) => void;
  /** Add the driving dimensions a type-while-drawing commit produced, in ONE step:
   * no own history push (the preceding clickAt already snapshotted, so the whole
   * typed shape is a single undo), and any dim that would over-constrain is demoted
   * to driven (reference) — same rule as addDimension. */
  addDrawDimensions: (constraints: SketchConstraint[]) => void;
  removeConstraint: (id: string) => void;
  /** Anchor / unanchor a point (the "fix" constraint). */
  toggleFix: (pointId: string) => void;
  /** Add a dimension on the selection, seeded at the measured value (FR-19). */
  addDimension: (kind: DimensionKind) => void;
  /** Edit a valued (dimension) constraint's value and re-solve. */
  setConstraintValue: (id: string, value: number) => void;
  setEditingDim: (id: string | null) => void;
  movePoint: (id: string, u: number, v: number) => void;
  setSelection: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  /** Place a point at (u,v) for the active drawing tool (M3.2). `opts` carry the
   * M3.3 inference: reuse an existing point (snap) or attach an H/V constraint. */
  clickAt: (
    u: number,
    v: number,
    opts?: { reusePointId?: string; constraint?: InferredConstraint },
  ) => void;
  /** Abort the in-progress gesture (Esc / tool switch). */
  cancelGesture: () => void;
  /** Commit a multi-click gesture in progress (Enter / double-click) — currently
   * the spline tool: turn the pending points into a spline entity. */
  finishGesture: () => void;
  /** Re-solve the current model and store the result; returns it. */
  solve: () => SolveResult;

  /** Snapshot the current model onto the undo stack before a mutation (clears the
   * redo stack). Called by every model-mutating action; also exposed so the
   * overlay can snapshot once at the start of a point drag (not per move). */
  pushHistory: () => void;
  /** Undo the last sketch action (sketch-local; the document store is untouched —
   * ADR-0013). No-op when there's nothing to undo. */
  undo: () => void;
  /** Redo the last undone sketch action. No-op when there's nothing to redo. */
  redo: () => void;
}

/** Cap the sketch undo history so a long session can't grow it without bound. */
const HISTORY_LIMIT = 200;

let seq = 0;
/** Deterministic-enough id for transient sketch entities (no RNG/time). */
function id(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export const useSketchStore = create<SketchStore>((set, get) => ({
  active: false,
  editingFeatureId: null,
  consumer: null,
  model: emptySketch(),
  view: centeredView(800, 600),
  tool: "select",
  pending: [],
  construction: false,
  polygonSides: 6,
  result: null,
  selection: [],
  editingDim: null,
  solverReady: false,
  resolvedFrame: null,
  past: [],
  future: [],
  setSolverReady: (ready) => set({ solverReady: ready }),
  setResolvedFrame: (frame) => set({ resolvedFrame: frame }),

  enterSketch: (plane, offset = 0, featureId, model, consumer = null) => {
    // The sketcher solves synchronously; refuse to open it until planegcs is
    // loaded so a constraint solve can never race the wasm. The Sketch button is
    // also disabled while !solverReady, so this is a belt-and-suspenders guard.
    if (!get().solverReady) return;
    set({
      active: true,
      editingFeatureId: featureId ?? null,
      consumer: consumer ?? null,
      model: model ? structuredClone(model) : emptySketch(plane, offset),
      tool: "select",
      pending: [],
      result: null,
      selection: [],
      editingDim: null,
      past: [],
      future: [],
    });
  },

  exitSketch: () =>
    set({
      active: false,
      editingFeatureId: null,
      consumer: null,
      selection: [],
      pending: [],
      past: [],
      future: [],
    }),
  setView: (view) => set({ view }),
  setTool: (tool) => set({ tool, selection: [], pending: [] }),
  setConstruction: (on) => set({ construction: on }),
  setPolygonSides: (n) => set({ polygonSides: Math.max(3, Math.round(n)) }),

  addPoint: (p) => {
    get().pushHistory();
    const pid = id("p");
    set((s) => ({ model: { ...s.model, points: [...s.model.points, { ...p, id: pid }] } }));
    return pid;
  },

  addEntity: (e) => {
    get().pushHistory();
    set((s) => ({ model: { ...s.model, entities: [...s.model.entities, e] } }));
  },

  addConstraint: (c) => {
    get().pushHistory();
    set((s) => ({ model: { ...s.model, constraints: [...s.model.constraints, c] } }));
    get().solve();
  },

  applyConstraint: (kind) => {
    const { model, selection } = get();
    const added = buildConstraints(kind, model, selection, () => id("c"));
    if (added.length === 0) return;
    get().pushHistory();
    set((s) => ({
      model: { ...s.model, constraints: [...s.model.constraints, ...added] },
      selection: [],
    }));
    get().solve();
  },

  addDrawDimensions: (constraints) => {
    if (constraints.length === 0) return;
    // No pushHistory: the clickAt that placed this shape already snapshotted, so the
    // geometry + its typed dimensions undo together as one step.
    set((s) => ({
      model: { ...s.model, constraints: [...s.model.constraints, ...constraints] },
    }));
    const result = get().solve();
    // A typed value that would over-constrain becomes a driven (reference) dimension
    // (FR-19) — it reports its value but adds no solver equation, so it never conflicts.
    if (result.verdict === "over-constrained") {
      const ids = new Set(constraints.map((c) => c.id));
      set((s) => ({
        model: {
          ...s.model,
          constraints: s.model.constraints.map((c) =>
            ids.has(c.id) && "value" in c ? { ...c, driven: true } : c,
          ),
        },
      }));
      get().solve();
    }
  },

  toggleFix: (pointId) => {
    get().pushHistory();
    set((s) => ({
      model: {
        ...s.model,
        points: s.model.points.map((p) => (p.id === pointId ? { ...p, fixed: !p.fixed } : p)),
      },
    }));
    get().solve();
  },

  addDimension: (kind) => {
    const { model, selection } = get();
    const value = measure(kind, model, selection);
    if (value == null) return;
    const cid = id("c");
    const dim = buildDimension(kind, model, selection, value, cid);
    if (!dim) return;
    get().pushHistory();
    set((s) => ({
      model: { ...s.model, constraints: [...s.model.constraints, dim] },
      selection: [],
      editingDim: cid, // open the value editor immediately
    }));
    const result = get().solve();
    // Driving/driven auto-demote (FR-19): a dimension that would over-constrain
    // the sketch becomes a driven (reference) dimension — it reports a value but
    // adds no solver equation, so it never conflicts.
    if (result.verdict === "over-constrained") {
      set((s) => ({
        model: {
          ...s.model,
          constraints: s.model.constraints.map((c) =>
            c.id === cid && "value" in c ? { ...c, driven: true } : c,
          ),
        },
        editingDim: null, // a driven value isn't user-editable
      }));
      get().solve();
    }
  },

  setConstraintValue: (cid, value) => {
    get().pushHistory();
    set((s) => ({
      model: {
        ...s.model,
        constraints: s.model.constraints.map((c) =>
          c.id === cid && "value" in c ? { ...c, value } : c,
        ),
      },
    }));
    get().solve();
  },

  setEditingDim: (cid) => set({ editingDim: cid }),

  removeConstraint: (cid) => {
    get().pushHistory();
    set((s) => ({
      model: { ...s.model, constraints: s.model.constraints.filter((c) => c.id !== cid) },
    }));
    get().solve();
  },

  movePoint: (pid, u, v) =>
    set((s) => ({
      model: {
        ...s.model,
        points: s.model.points.map((p) => (p.id === pid ? { ...p, u, v } : p)),
      },
    })),

  setSelection: (ids) => set({ selection: ids }),
  toggleSelect: (sid) =>
    set((s) => ({
      selection: s.selection.includes(sid)
        ? s.selection.filter((x) => x !== sid)
        : [...s.selection, sid],
    })),

  cancelGesture: () => set({ pending: [] }),

  finishGesture: () => {
    const { tool, pending, construction } = get();
    if (tool === "spline" && pending.length >= 2) {
      get().pushHistory();
      const ctor = construction ? { construction: true } : {};
      set((s) => ({
        model: {
          ...s.model,
          entities: [
            ...s.model.entities,
            { id: id("e"), kind: "spline", points: [...pending], ...ctor },
          ],
        },
        pending: [],
      }));
      get().solve();
      return;
    }
    set({ pending: [] });
  },

  clickAt: (u, v, opts) => {
    const { tool, construction } = get();
    // Each placement is an undo step (select clicks aren't routed here).
    if (tool !== "select") get().pushHistory();
    const ctor = construction ? { construction: true } : {};
    const newPoint = (pu: number, pv: number): string => {
      const pid = id("p");
      set((s) => ({
        model: { ...s.model, points: [...s.model.points, { id: pid, u: pu, v: pv }] },
      }));
      return pid;
    };
    const addLine = (a: string, b: string): string => {
      const lid = id("e");
      set((s) => ({
        model: {
          ...s.model,
          entities: [...s.model.entities, { id: lid, kind: "line", a, b, ...ctor }],
        },
      }));
      return lid;
    };
    const addArc = (a: string, b: string, through: string): void => {
      set((s) => ({
        model: {
          ...s.model,
          entities: [...s.model.entities, { id: id("e"), kind: "arc", a, b, through, ...ctor }],
        },
      }));
    };

    if (tool === "line") {
      // Chained polyline: connect the previous pending point to a new one. A
      // snap may reuse an existing point (true connection) and the inference may
      // attach an H/V constraint to the new segment.
      const prev = get().pending[0];
      const next = opts?.reusePointId ?? newPoint(u, v);
      if (prev) {
        const lid = addLine(prev, next);
        const c = opts?.constraint;
        if (c) {
          let con: SketchConstraint;
          if (c.kind === "parallel" || c.kind === "perpendicular") {
            con = { id: id("c"), kind: c.kind, line1: lid, line2: c.refLine };
          } else if (c.kind === "tangent") {
            con = { id: id("c"), kind: "tangent", line: lid, circle: c.circle };
          } else {
            con = { id: id("c"), kind: c.kind, line: lid };
          }
          set((s) => ({ model: { ...s.model, constraints: [...s.model.constraints, con] } }));
        }
      }
      set({ pending: [next] });
      get().solve();
      return;
    }

    if (tool === "rectangle") {
      const first = get().pending[0];
      if (!first) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      // Second corner → axis-aligned rectangle from the two opposite corners.
      const p0 = get().model.points.find((p) => p.id === first)!;
      const a = first;
      const b = newPoint(u, p0.v);
      const c = newPoint(u, v);
      const d = newPoint(p0.u, v);
      addLine(a, b);
      addLine(b, c);
      addLine(c, d);
      addLine(d, a);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "circle") {
      const centerId = get().pending[0];
      if (!centerId) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      const c = get().model.points.find((p) => p.id === centerId)!;
      const radius = Math.hypot(u - c.u, v - c.v);
      set((s) => ({
        model: {
          ...s.model,
          entities: [
            ...s.model.entities,
            { id: id("e"), kind: "circle", center: centerId, radius, ...ctor },
          ],
        },
        pending: [],
      }));
      get().solve();
      return;
    }

    if (tool === "rectCenter") {
      // First click = centre; second click = a corner → centred rectangle.
      const centerId = get().pending[0];
      if (!centerId) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      const ctr = get().model.points.find((p) => p.id === centerId)!;
      const cu = ctr.u;
      const cv = ctr.v;
      const hw = Math.abs(u - cu);
      const hh = Math.abs(v - cv);
      // The centre is not a rectangle vertex — drop the temp centre point.
      set((s) => ({
        model: { ...s.model, points: s.model.points.filter((p) => p.id !== centerId) },
      }));
      const a = newPoint(cu - hw, cv - hh);
      const b = newPoint(cu + hw, cv - hh);
      const c = newPoint(cu + hw, cv + hh);
      const d = newPoint(cu - hw, cv + hh);
      addLine(a, b);
      addLine(b, c);
      addLine(c, d);
      addLine(d, a);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "circle3") {
      // Three clicks define a circle through them (the circumcircle).
      const next = opts?.reusePointId ?? newPoint(u, v);
      const acc = [...get().pending, next];
      if (acc.length < 3) {
        set({ pending: acc });
        return;
      }
      const pts = acc.map((pid) => get().model.points.find((p) => p.id === pid)!);
      const cc = circumcircle(
        [pts[0]!.u, pts[0]!.v],
        [pts[1]!.u, pts[1]!.v],
        [pts[2]!.u, pts[2]!.v],
      );
      if (!cc) {
        // Collinear — discard the gesture's temp points and restart.
        set((s) => ({
          model: { ...s.model, points: s.model.points.filter((p) => !acc.includes(p.id)) },
          pending: [],
        }));
        return;
      }
      const centerId = id("p");
      set((s) => ({
        model: {
          ...s.model,
          // Replace the three temp on-circle points with a single centre point.
          points: [
            ...s.model.points.filter((p) => !acc.includes(p.id)),
            { id: centerId, u: cc.u, v: cc.v },
          ],
          entities: [
            ...s.model.entities,
            { id: id("e"), kind: "circle", center: centerId, radius: cc.r, ...ctor },
          ],
        },
        pending: [],
      }));
      get().solve();
      return;
    }

    if (tool === "arc3") {
      // Three clicks in order along the arc: start, a point on it, end.
      const next = opts?.reusePointId ?? newPoint(u, v);
      const acc = [...get().pending, next];
      if (acc.length < 3) {
        set({ pending: acc });
        return;
      }
      // a = first, b = last, through = the middle click.
      addArc(acc[0]!, acc[2]!, acc[1]!);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "arcCenter") {
      // Click 1 = centre, click 2 = start (sets radius), click 3 = end angle.
      const acc = get().pending;
      if (acc.length === 0) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      if (acc.length === 1) {
        set({ pending: [acc[0]!, opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      const centre = get().model.points.find((p) => p.id === acc[0]!)!;
      const start = get().model.points.find((p) => p.id === acc[1]!)!;
      const c: [number, number] = [centre.u, centre.v];
      const r = Math.hypot(start.u - c[0], start.v - c[1]);
      const endP = projectToCircle(c, r, [u, v]);
      const mid = arcMidpoint(c, [start.u, start.v], [endP.u, endP.v]);
      // The centre is a construction reference, not a profile vertex — drop it.
      set((s) => ({
        model: { ...s.model, points: s.model.points.filter((p) => p.id !== acc[0]!) },
      }));
      const endId = newPoint(endP.u, endP.v);
      const throughId = newPoint(mid.u, mid.v);
      addArc(acc[1]!, endId, throughId);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "polygon") {
      // Click 1 = centre, click 2 = a vertex → a regular n-gon (centre dropped).
      const centerId = get().pending[0];
      if (!centerId) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      const ctr = get().model.points.find((p) => p.id === centerId)!;
      const verts = regularPolygonVertices([ctr.u, ctr.v], [u, v], get().polygonSides);
      // The centre is a reference, not a polygon vertex — drop it.
      set((s) => ({
        model: { ...s.model, points: s.model.points.filter((p) => p.id !== centerId) },
      }));
      const ids = verts.map((p) => newPoint(p.u, p.v));
      for (let i = 0; i < ids.length; i++) addLine(ids[i]!, ids[(i + 1) % ids.length]!);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "slot") {
      // Clicks 1,2 = centre-line ends; click 3 sets the slot radius (width/2).
      const acc = get().pending;
      if (acc.length === 0) {
        set({ pending: [opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      if (acc.length === 1) {
        set({ pending: [acc[0]!, opts?.reusePointId ?? newPoint(u, v)] });
        return;
      }
      const a = get().model.points.find((p) => p.id === acc[0]!)!;
      const b = get().model.points.find((p) => p.id === acc[1]!)!;
      const r = perpDistance([u, v], [a.u, a.v], [b.u, b.v]);
      const o = slotOutline([a.u, a.v], [b.u, b.v], r);
      if (!o) {
        // Degenerate (zero length or width) — discard the centre-line anchors.
        set((s) => ({
          model: { ...s.model, points: s.model.points.filter((p) => !acc.includes(p.id)) },
          pending: [],
        }));
        return;
      }
      // The centre line is construction reference, not the profile — drop its pts.
      set((s) => ({
        model: { ...s.model, points: s.model.points.filter((p) => !acc.includes(p.id)) },
      }));
      const a1 = newPoint(o.a1.u, o.a1.v);
      const b1 = newPoint(o.b1.u, o.b1.v);
      const capB = newPoint(o.capB.u, o.capB.v);
      const b2 = newPoint(o.b2.u, o.b2.v);
      const a2 = newPoint(o.a2.u, o.a2.v);
      const capA = newPoint(o.capA.u, o.capA.v);
      addLine(a1, b1);
      addArc(b1, b2, capB);
      addLine(b2, a2);
      addArc(a2, a1, capA);
      set({ pending: [] });
      get().solve();
      return;
    }

    if (tool === "spline") {
      // Accumulate interpolation points; finishGesture (Enter/double-click) commits.
      set({ pending: [...get().pending, opts?.reusePointId ?? newPoint(u, v)] });
      return;
    }

    if (tool === "point") {
      // A standalone reference/snap point (FR-16); no gesture state.
      newPoint(u, v);
      return;
    }
    // "select" tool: clicks are handled by the overlay (selection), not here.
  },

  solve: () => {
    const { model } = get();
    const input = toSolverInput(model);
    const result = solveSketch(input.points, input.circles, input.constraints);
    // Write the solved positions back so the canvas reflects the satisfied model.
    // `result.radii` is parallel to the circle entities in `entities.filter(kind === "circle")`
    // order — the same order `toSolverInput` emits them — so consume it with a running circle
    // index as we walk the heterogeneous entity list. Without this, an edited radius/diameter
    // dimension (or a tangent/concentric resize) is solved but never applied to the entity,
    // and the stale radius leaks into the rendered circle, the extracted profile, and hit-testing.
    set((s) => {
      let circleIdx = 0;
      return {
        result,
        model: {
          ...s.model,
          points: s.model.points.map((p, i) => {
            const sp = result.points[i];
            return sp ? { ...p, u: sp.x, v: sp.y } : p;
          }),
          entities: s.model.entities.map((e) => {
            if (e.kind !== "circle") return e;
            const r = result.radii[circleIdx++];
            return r != null ? { ...e, radius: r } : e;
          }),
        },
      };
    });
    return result;
  },

  pushHistory: () =>
    set((s) => ({
      past: [...s.past, structuredClone(s.model)].slice(-HISTORY_LIMIT),
      future: [], // a new action invalidates the redo stack
    })),

  undo: () => {
    const { past } = get();
    if (past.length === 0) return;
    set((s) => ({
      model: s.past[s.past.length - 1]!,
      past: s.past.slice(0, -1),
      future: [structuredClone(s.model), ...s.future].slice(0, HISTORY_LIMIT),
      // A restore invalidates any in-progress gesture / selection / dim edit.
      pending: [],
      selection: [],
      editingDim: null,
    }));
    get().solve(); // refresh the solver result (DOF/verdict) for the restored model
  },

  redo: () => {
    const { future } = get();
    if (future.length === 0) return;
    set((s) => ({
      model: s.future[0]!,
      future: s.future.slice(1),
      past: [...s.past, structuredClone(s.model)].slice(-HISTORY_LIMIT),
      pending: [],
      selection: [],
      editingDim: null,
    }));
    get().solve();
  },
}));

/** Make a sketch constraint id (exported for tools/UI). */
export const sketchId = id;
