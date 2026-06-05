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

/** The constraint vocabulary, referencing points/circles by input index. */
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
  | { kind: "radius"; circle: number; value: number }
  | { kind: "concentric"; a: number; b: number }
  | { kind: "tangentLineCircle"; a: number; b: number; circle: number }
  | { kind: "midpoint"; m: number; a: number; b: number }
  | { kind: "pointOnLine"; p: number; a: number; b: number }
  | { kind: "pointOnCircle"; p: number; circle: number }
  | { kind: "symmetric"; a: number; b: number; c: number; d: number };

export type SketchVerdict = "under-constrained" | "well-constrained" | "over-constrained";

export interface SolveResult {
  /** Solved point positions, parallel to the input `points`. */
  points: SolverPoint[];
  /** Solved circle radii, parallel to the input `circles`. */
  radii: number[];
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
    })();
  }
  return initPromise;
}

const px = (i: number): string => `p${i}`;
const cx = (i: number): string => `c${i}`;

/**
 * Solve the sketch. Returns the satisfied point positions and circle radii plus a
 * three-state verdict and the remaining DOF. Requires `initSketchSolver()` first.
 */
export function solveSketch(
  points: SolverPoint[],
  circles: SolverCircle[],
  constraints: Constraint[],
): SolveResult {
  if (points.length === 0) {
    return { points: [], radii: [], verdict: "well-constrained", freedom: 0 };
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

  const freedom = gcs.gcs.dof();
  const conflicting = gcs.has_gcs_conflicting_constraints();
  const failed = status === SolveStatus.Failed || status === SolveStatus.SuccessfulSolutionInvalid;
  const verdict: SketchVerdict =
    conflicting || failed ? "over-constrained" : freedom > 0 ? "under-constrained" : "well-constrained";

  return { points: solvedPoints, radii, verdict, freedom };
}
