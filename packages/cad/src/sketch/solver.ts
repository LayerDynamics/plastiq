// 2D sketch constraint solver, backed by @salusoft89/planegcs (FreeCAD PlaneGCS
// compiled to wasm). The app authors a sketch as a numeric-index model and calls
// `solveSketch` SYNCHRONOUSLY; planegcs needs an async wasm load, so the module is
// initialised once via `initSketchSolver()` (awaited at startup) and reused.

import { GcsWrapper, SolveStatus, init_planegcs_module } from "@salusoft89/planegcs";

/** A sketch point in plane space; `fixed` anchors it. */
export interface SolverPoint {
  x: number;
  y: number;
  fixed?: boolean;
}

/** A circle in the solver input: its centre is one of the points (by index). */
export interface SolverCircle {
  center: number;
  radius: number;
}

/**
 * An ellipse in the solver input. planegcs parameterises an ellipse by its centre
 * point, ONE focus point, and the minor (semi-minor) radius — the major axis
 * direction is centre→focus1 and the major radius is derived
 * (radmaj = √(radmin² + f²), f = |centre − focus1|). Both `center` and `focus1`
 * are indices into the shared `points` array, exactly like {@link SolverCircle}'s
 * `center`, so they can be constrained by any point constraint (fixed/coincident/…).
 */
export interface SolverEllipse {
  center: number;
  focus1: number;
  /** Minor (semi-minor) radius. */
  radmin: number;
}

/**
 * An arc of a circle in the solver input: a centre point plus start/end endpoint
 * points (indices into the shared `points` array) and the radius. planegcs also
 * needs start/end angles; the solver derives them from the endpoints and adds a
 * per-arc `arc_rules` constraint so radius and the two endpoints stay mutually
 * consistent (endpoints held at `radius` from the centre). This makes the arc's
 * `radius` a real geometric quantity that `equalRadius`/`tangent` can drive.
 */
export interface SolverArc {
  center: number;
  start: number;
  end: number;
  radius: number;
}

/** The constraint vocabulary, referencing points/circles/ellipses/arcs by input index. */
export type Constraint =
  | { kind: "horizontal"; a: number; b: number }
  | { kind: "vertical"; a: number; b: number }
  | { kind: "coincident"; a: number; b: number }
  | { kind: "distance"; a: number; b: number; value: number }
  | { kind: "hDistance"; a: number; b: number; value: number }
  | { kind: "vDistance"; a: number; b: number; value: number }
  | { kind: "parallel"; a: number; b: number; c: number; d: number }
  | { kind: "perpendicular"; a: number; b: number; c: number; d: number }
  | { kind: "equalLength"; a: number; b: number; c: number; d: number }
  | { kind: "angle"; a: number; b: number; c: number; d: number; value: number }
  | { kind: "lineAngle"; a: number; b: number; value: number }
  | { kind: "radius"; circle: number; value: number }
  | { kind: "concentric"; a: number; b: number }
  | { kind: "tangentLineCircle"; a: number; b: number; circle: number }
  | { kind: "midpoint"; m: number; a: number; b: number }
  | { kind: "pointOnLine"; p: number; a: number; b: number }
  | { kind: "pointOnCircle"; p: number; circle: number }
  | { kind: "symmetric"; a: number; b: number; c: number; d: number }
  // Radius equality — the curved-geometry analogue of `equalLength`. Circle↔circle
  // and arc↔arc; `a`/`b` index the `circles` or `arcs` array respectively.
  | { kind: "equalRadius"; a: number; b: number }
  | { kind: "equalRadiusArc"; a: number; b: number }
  | { kind: "equalRadiusCircleArc"; circle: number; arc: number }
  // Curve-to-curve tangency, extending the line↔circle `tangentLineCircle`.
  // `tangentCircles`: circle `a` ↔ circle `b`. `tangentArcCircle`: circle ↔ arc
  // (arc-endpoint / arc-to-curve tangency). Indices point into `circles`/`arcs`.
  | { kind: "tangentCircles"; a: number; b: number }
  | { kind: "tangentArcs"; a: number; b: number }
  | { kind: "tangentArcCircle"; circle: number; arc: number }
  // A point constrained to lie on an ellipse; `ellipse` indexes the `ellipses` array.
  | { kind: "pointOnEllipse"; p: number; ellipse: number };

export type SketchVerdict = "under-constrained" | "well-constrained" | "over-constrained";

export interface SolveResult {
  /** Solved point positions, parallel to the input `points`. */
  points: SolverPoint[];
  /** Solved circle radii, parallel to the input `circles`. */
  radii: number[];
  /** Solved ellipse minor radii, parallel to the input `ellipses` (empty if none). */
  ellipseRadmin: number[];
  /** Solved arc radii, parallel to the input `arcs` (empty if none). */
  arcRadii: number[];
  verdict: SketchVerdict;
  /** Remaining degrees of freedom (0 = fully constrained). */
  freedom: number;
}

type Primitive = Parameters<GcsWrapper["push_primitives_and_params"]>[0][number];

let wrapper: GcsWrapper | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Load the planegcs wasm and create the shared solver. Must be awaited once
 * before any `solveSketch` call. In the browser pass the bundler-resolved wasm
 * URL; in Node it self-locates.
 */
export function initSketchSolver(opts?: { wasmUrl?: string }): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await init_planegcs_module(
        opts?.wasmUrl ? { locateFile: () => opts.wasmUrl as string } : undefined,
      );
      wrapper = new GcsWrapper(new mod.GcsSystem());
    })().catch((err: unknown) => {
      // Don't poison the memo: a transient wasm-load failure must not make every
      // future call re-await the same rejected promise — clear it so a later
      // call can retry. Same pattern as lower/decompose.ts initDecomposer.
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

/**
 * True once {@link initSketchSolver} has loaded the planegcs wasm and the shared
 * solver exists — i.e. `solveSketch` is safe to call. The UI gates entering the
 * sketcher on this so a synchronous solve never races the (small, fast) wasm load.
 */
export function sketchSolverReady(): boolean {
  return wrapper !== null;
}

const px = (i: number): string => `p${i}`;
const cx = (i: number): string => `c${i}`;
const ex = (i: number): string => `e${i}`;
const ax = (i: number): string => `a${i}`;

/**
 * Solve the sketch. Returns the satisfied point positions and circle/arc/ellipse
 * radii plus a three-state verdict and the remaining DOF. Requires
 * `initSketchSolver()` first. `ellipses` and `arcs` default to empty, so existing
 * three-argument callers keep working unchanged.
 */
export function solveSketch(
  points: SolverPoint[],
  circles: SolverCircle[],
  constraints: Constraint[],
  ellipses: SolverEllipse[] = [],
  arcs: SolverArc[] = [],
): SolveResult {
  if (points.length === 0) {
    return {
      points: [],
      radii: [],
      ellipseRadmin: [],
      arcRadii: [],
      verdict: "well-constrained",
      freedom: 0,
    };
  }
  if (!wrapper) {
    throw new Error("solveSketch: call (and await) initSketchSolver() before solving");
  }
  const gcs = wrapper;
  gcs.clear_data();

  const prims: Primitive[] = [];
  points.forEach((p, i) => {
    prims.push({
      id: px(i),
      type: "point",
      x: p.x,
      y: p.y,
      fixed: p.fixed ?? false,
    } as Primitive);
  });
  circles.forEach((c, j) => {
    prims.push({ id: cx(j), type: "circle", c_id: px(c.center), radius: c.radius } as Primitive);
  });
  ellipses.forEach((e, k) => {
    // planegcs ellipse := centre point + one focus point + minor radius.
    prims.push({
      id: ex(k),
      type: "ellipse",
      c_id: px(e.center),
      focus1_id: px(e.focus1),
      radmin: e.radmin,
    } as Primitive);
  });
  arcs.forEach((arc, k) => {
    // Derive the start/end angles from the endpoint positions relative to the
    // centre so the initial guess is geometrically consistent; `arc_rules` (added
    // just below) then holds radius and the two endpoints mutually consistent
    // through the solve.
    const c = points[arc.center]!;
    const s = points[arc.start]!;
    const e = points[arc.end]!;
    prims.push({
      id: ax(k),
      type: "arc",
      c_id: px(arc.center),
      start_id: px(arc.start),
      end_id: px(arc.end),
      start_angle: Math.atan2(s.y - c.y, s.x - c.x),
      end_angle: Math.atan2(e.y - c.y, e.x - c.x),
      radius: arc.radius,
    } as Primitive);
  });

  // Lines are created on demand for the constraints that planegcs expresses by
  // line id (parallel / equal-length / tangent / symmetric-axis).
  const lineIds = new Map<string, string>();
  let lineSeq = 0;
  const lineFor = (a: number, b: number): string => {
    const key = `${a},${b}`;
    const existing = lineIds.get(key);
    if (existing) return existing;
    const id = `l${lineSeq++}`;
    lineIds.set(key, id);
    prims.push({ id, type: "line", p1_id: px(a), p2_id: px(b) } as Primitive);
    return id;
  };

  let cSeq = 0;
  const cid = (): string => `k${cSeq++}`;
  const add = (c: object): void => {
    prims.push({ id: cid(), ...c } as Primitive);
  };

  // Every arc gets planegcs' `arc_rules`, which ties its radius/start/end params to
  // its centre and endpoint points (endpoints held at `radius`, angles matching the
  // endpoints). Without it the arc's `radius` would be a free scalar unrelated to
  // the geometry, so `equalRadiusArc`/`tangentArcCircle` could not drive real radii.
  arcs.forEach((_, k) => {
    add({ type: "arc_rules", a_id: ax(k) });
  });

  for (const c of constraints) {
    switch (c.kind) {
      case "horizontal":
        add({ type: "horizontal_pp", p1_id: px(c.a), p2_id: px(c.b) });
        break;
      case "vertical":
        add({ type: "vertical_pp", p1_id: px(c.a), p2_id: px(c.b) });
        break;
      case "coincident":
      case "concentric":
        add({ type: "p2p_coincident", p1_id: px(c.a), p2_id: px(c.b) });
        break;
      case "distance":
        add({ type: "p2p_distance", p1_id: px(c.a), p2_id: px(c.b), distance: c.value });
        break;
      case "hDistance":
        // planegcs `difference` enforces param2 − param1 = difference, so with
        // param1 = a.x, param2 = b.x this gives b.x − a.x = value.
        add({
          type: "difference",
          param1: { o_id: px(c.a), prop: "x" },
          param2: { o_id: px(c.b), prop: "x" },
          difference: c.value,
        });
        break;
      case "vDistance":
        add({
          type: "difference",
          param1: { o_id: px(c.a), prop: "y" },
          param2: { o_id: px(c.b), prop: "y" },
          difference: c.value,
        });
        break;
      case "parallel":
        add({ type: "parallel", l1_id: lineFor(c.a, c.b), l2_id: lineFor(c.c, c.d) });
        break;
      case "perpendicular":
        add({
          type: "perpendicular_pppp",
          l1p1_id: px(c.a),
          l1p2_id: px(c.b),
          l2p1_id: px(c.c),
          l2p2_id: px(c.d),
        });
        break;
      case "equalLength":
        add({ type: "equal_length", l1_id: lineFor(c.a, c.b), l2_id: lineFor(c.c, c.d) });
        break;
      case "angle":
        add({
          type: "l2l_angle_pppp",
          l1p1_id: px(c.a),
          l1p2_id: px(c.b),
          l2p1_id: px(c.c),
          l2p2_id: px(c.d),
          angle: c.value,
        });
        break;
      case "lineAngle":
        // Angle of the directed line a→b measured from the +X axis (planegcs
        // p2p_angle). The single-line angle dimension Fusion shows while drawing.
        add({ type: "p2p_angle", p1_id: px(c.a), p2_id: px(c.b), angle: c.value });
        break;
      case "radius":
        add({ type: "circle_radius", c_id: cx(c.circle), radius: c.value });
        break;
      case "tangentLineCircle":
        add({ type: "tangent_lc", l_id: lineFor(c.a, c.b), c_id: cx(c.circle) });
        break;
      case "midpoint":
        // m is the midpoint of a-b ⇔ a and b are symmetric about m.
        add({ type: "p2p_symmetric_ppp", p1_id: px(c.a), p2_id: px(c.b), p_id: px(c.m) });
        break;
      case "pointOnLine":
        add({ type: "point_on_line_ppp", p_id: px(c.p), lp1_id: px(c.a), lp2_id: px(c.b) });
        break;
      case "pointOnCircle":
        add({ type: "point_on_circle", p_id: px(c.p), c_id: cx(c.circle) });
        break;
      case "symmetric":
        add({ type: "p2p_symmetric_ppl", p1_id: px(c.a), p2_id: px(c.b), l_id: lineFor(c.c, c.d) });
        break;
      case "equalRadius":
        add({ type: "equal_radius_cc", c1_id: cx(c.a), c2_id: cx(c.b) });
        break;
      case "equalRadiusArc":
        add({ type: "equal_radius_aa", a1_id: ax(c.a), a2_id: ax(c.b) });
        break;
      case "equalRadiusCircleArc":
        add({ type: "equal_radius_ca", c1_id: cx(c.circle), a2_id: ax(c.arc) });
        break;
      case "tangentCircles":
        add({ type: "tangent_cc", c1_id: cx(c.a), c2_id: cx(c.b) });
        break;
      case "tangentArcs":
        add({ type: "tangent_aa", a1_id: ax(c.a), a2_id: ax(c.b) });
        break;
      case "tangentArcCircle":
        add({ type: "tangent_ca", c_id: cx(c.circle), a_id: ax(c.arc) });
        break;
      case "pointOnEllipse":
        add({ type: "point_on_ellipse", p_id: px(c.p), e_id: ex(c.ellipse) });
        break;
    }
  }

  gcs.push_primitives_and_params(prims);
  const status = gcs.solve();
  gcs.apply_solution();

  const solvedPoints: SolverPoint[] = points.map((_, i) => {
    const sp = gcs.sketch_index.get_sketch_point(px(i));
    return { x: sp.x, y: sp.y };
  });
  const radii = circles.map((_, j) => gcs.sketch_index.get_sketch_circle(cx(j)).radius);
  // SketchIndex exposes typed getters for point/line/circle/arc but not ellipse,
  // so read the solved ellipse back through the generic primitive accessor.
  const ellipseRadmin = ellipses.map((_, k) => {
    const prim = gcs.sketch_index.get_primitive(ex(k)) as { radmin: number } | undefined;
    return prim?.radmin ?? NaN;
  });
  const arcRadii = arcs.map((_, k) => gcs.sketch_index.get_sketch_arc(ax(k)).radius);

  const freedom = gcs.gcs.dof();
  const conflicting = gcs.has_gcs_conflicting_constraints();
  // A redundant constraint over-determines the sketch (e.g. a dimension added to
  // an already fully-constrained shape) — surface it as over-constrained too, so
  // the editor can auto-demote it to a driven/reference dimension (FR-19).
  const redundant = gcs.has_gcs_redundant_constraints();
  const failed = status === SolveStatus.Failed || status === SolveStatus.SuccessfulSolutionInvalid;
  const verdict: SketchVerdict =
    conflicting || redundant || failed
      ? "over-constrained"
      : freedom > 0
        ? "under-constrained"
        : "well-constrained";

  return { points: solvedPoints, radii, ellipseRadmin, arcRadii, verdict, freedom };
}
