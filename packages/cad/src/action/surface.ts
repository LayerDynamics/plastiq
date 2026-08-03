// §14 surface modeling kernel ops — open sheet bodies (faces / shells) built
// from profiles, point grids, offsets, and fills. Results wrap as {@link Solid}
// (a TopoDS_Shape carrier) whose underlying shape is a face or shell; zero volume
// and positive surface area distinguish them from closed solids.
//
// Closure ops `sew` / `solidify` live in heal.ts (same pillar, shared by import
// repair) — import them from there rather than redefining. `thicken` (thicken.ts)
// is the bridge from sheets back to solids.

import type {
  BRepBuilderAPI_TransitionMode,
  BRepAdaptor_Surface,
  GeomAbs_Shape,
  Handle_Geom_Surface,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Wire,
} from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import type { DatumPlane } from "../env/plane.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { buildSpineWire, type SpinePath } from "../sketch/spine.js";
import { shapeEnums } from "../mesh/normals.js";
import type { LoftOptions, SweepOptions, SweepTransition } from "./loft.js";
import { split } from "./split.js";

export type { LoftOptions, SweepOptions, SweepTransition };

export interface SurfaceFromPointsOptions {
  /** Minimum / U-side degree for the B-spline fit (default 3). */
  readonly degU?: number;
  /** Maximum / V-side degree for the B-spline fit (default 8). */
  readonly degV?: number;
  /** 3D fitting tolerance in metres (default 1e-6). */
  readonly tolerance?: number;
}

export interface PatchOptions {
  /**
   * Continuity order of boundary constraints.
   * - `c0` (default): position only.
   * - `c1` / `g1`: tangent (GeomAbs_G1).
   * - `c2` / `g2`: curvature (GeomAbs_G2).
   */
  readonly continuity?: "c0" | "c1" | "g1" | "c2" | "g2";
  /** Optional interior point constraints the filled surface should pass through. */
  readonly passthroughPoints?: readonly Vec3[];
}

export interface ExtendSurfaceOptions {
  /** Requested boundary continuity. OCCT supports C1, C2, or C3. Default C1. */
  readonly continuity?: 1 | 2 | 3;
}

/** Surface area of a face/shell body (SI m²). */
export function surfaceArea(oc: Occt, body: Solid): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(body.shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/**
 * Loft an open shell through ≥2 section profiles (`ThruSections(isSolid=false)`).
 * Same sections as {@link loft} but produces a zero-volume sheet instead of a solid.
 */
export function surfaceLoft(oc: Occt, sketches: readonly Sketch[], opts: LoftOptions): Solid {
  if (sketches.length < 2) throw new Error("surfaceLoft: needs at least 2 section profiles");
  const maker = new oc.BRepOffsetAPI_ThruSections(false, opts.ruled, 1e-6);
  const progress = new oc.Message_ProgressRange_1();
  const wires: TopoDS_Wire[] = [];
  try {
    for (const s of sketches) {
      const w = s.toWire(oc);
      wires.push(w);
      maker.AddWire(w);
    }
    maker.Build(progress);
    if (!maker.IsDone()) {
      throw new Error(
        "surfaceLoft: ThruSections could not build a shell through the given sections",
      );
    }
    const shape = maker.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("surfaceLoft: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
    progress.delete();
    for (const w of wires) w.delete();
  }
}

/**
 * Sweep a profile along a spine into an open pipe shell — `MakePipeShell`
 * **without** `MakeSolid()`. Contrast {@link sweep} which caps into a solid.
 */
export function surfaceSweep(
  oc: Occt,
  sketch: Sketch,
  path: SpinePath,
  opts?: SweepOptions,
): Solid {
  const spine = buildSpineWire(oc, path);
  return surfaceSweepAlongWire(oc, sketch, spine, opts);
}

/**
 * Surface-sweep along an already-built spine wire. Takes ownership of `spine`
 * (deleted on every exit), matching {@link sweepAlongWire}.
 */
export function surfaceSweepAlongWire(
  oc: Occt,
  sketch: Sketch,
  spine: TopoDS_Wire,
  opts?: SweepOptions,
): Solid {
  const profile = sketch.toWire(oc);
  const maker = new oc.BRepOffsetAPI_MakePipeShell(spine);
  const progress = new oc.Message_ProgressRange_1();
  try {
    const mode = opts?.mode ?? "correctedFrenet";
    if (mode === "frenet") maker.SetMode_1(true);
    else maker.SetMode_1(false);

    const transition = opts?.transition ?? "right";
    const TM = oc.BRepBuilderAPI_TransitionMode;
    const tm =
      transition === "round"
        ? TM.BRepBuilderAPI_RoundCorner
        : transition === "transformed"
          ? TM.BRepBuilderAPI_Transformed
          : TM.BRepBuilderAPI_RightCorner;
    maker.SetTransitionMode(tm as unknown as BRepBuilderAPI_TransitionMode);
    maker.Add_1(profile, false, false);

    if (!maker.IsReady()) throw new Error("surfaceSweep: the profile/spine are not ready to sweep");
    maker.Build(progress);
    if (!maker.IsDone()) {
      throw new Error("surfaceSweep: MakePipeShell failed to build the swept shell");
    }
    // Deliberately NO MakeSolid() — leave the open pipe shell.
    const shape = maker.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("surfaceSweep: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
    progress.delete();
    profile.delete();
    spine.delete();
  }
}

/**
 * Revolve a sketch profile about an axis into a surface of revolution.
 *
 * Uses `MakeRevol` on the profile **wire** (not face) so the result is a shell /
 * face sheet rather than a solid. The sketch wire is still auto-closed by
 * {@link Sketch.toWire} today; a true open-profile mode lands with sketch open
 * wires (FablesFindings §14) and does not require a new binding here.
 */
export function surfaceRevolve(
  oc: Occt,
  sketch: Sketch,
  origin: Vec3,
  axis: Vec3,
  angle: number,
): Solid {
  if (!Number.isFinite(angle) || angle === 0) {
    throw new Error("surfaceRevolve: angle must be non-zero");
  }
  if (Math.abs(angle) > 2 * Math.PI + 1e-9) {
    throw new Error(
      `surfaceRevolve: angle ${angle} exceeds a full turn (±2π); OCCT would silently wrap it modulo 2π`,
    );
  }
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(axisLen) || axisLen === 0) {
    throw new Error("surfaceRevolve: axis must be a non-zero vector");
  }

  const wire = sketch.toWire(oc);
  const trash: Array<{ delete(): void }> = [wire];
  try {
    const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
    trash.push(o);
    const d = new oc.gp_Dir_4(axis[0], axis[1], axis[2]);
    trash.push(d);
    const ax = new oc.gp_Ax1_2(o, d);
    trash.push(ax);
    const rev = new oc.BRepPrimAPI_MakeRevol_1(wire, ax, angle, false);
    trash.push(rev);
    const shape = rev.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("surfaceRevolve: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Fit a B-spline surface through a rectangular point grid and return it as a
 * bounded face (`GeomAPI_PointsToBSplineSurface` → `BRepBuilderAPI_MakeFace`).
 *
 * `grid` is row-major in U then V: `grid[i][j]` is pole (i+1, j+1) in OCCT
 * (1-based), matching the nurbs service convention.
 */
export function surfaceFromPoints(
  oc: Occt,
  grid: readonly (readonly Vec3[])[],
  opts?: SurfaceFromPointsOptions,
): Solid {
  if (grid.length < 2) {
    throw new Error("surfaceFromPoints: grid needs at least 2 rows");
  }
  const nU = grid.length;
  const nV = grid[0]!.length;
  if (nV < 2) {
    throw new Error("surfaceFromPoints: grid needs at least 2 columns");
  }
  for (let i = 0; i < nU; i++) {
    if (grid[i]!.length !== nV) {
      throw new Error(
        `surfaceFromPoints: row ${i} has ${grid[i]!.length} points; expected ${nV} (rectangular grid)`,
      );
    }
  }

  const degU = opts?.degU ?? 3;
  const degV = opts?.degV ?? 8;
  const tol = opts?.tolerance ?? 1e-6;
  if (!Number.isFinite(degU) || !Number.isFinite(degV) || degU < 1 || degV < 1) {
    throw new Error("surfaceFromPoints: degU and degV must be finite and ≥ 1");
  }
  // OCCT takes DegMin/DegMax (shared for both parametric directions), not separate
  // U/V degrees. Map degU → min and degV → max (swap if the caller inverted them).
  const degMin = Math.min(Math.floor(degU), Math.floor(degV));
  const degMax = Math.max(Math.floor(degU), Math.floor(degV));

  const trash: Array<{ delete(): void }> = [];
  try {
    const arr = new oc.TColgp_Array2OfPnt_2(1, nU, 1, nV);
    trash.push(arr);
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        const p = grid[i]![j]!;
        const gp = new oc.gp_Pnt_3(p[0], p[1], p[2]);
        trash.push(gp);
        arr.SetValue(i + 1, j + 1, gp);
      }
    }

    const fitter = new oc.GeomAPI_PointsToBSplineSurface_2(
      arr,
      degMin,
      degMax,
      oc.GeomAbs_Shape.GeomAbs_C2 as unknown as GeomAbs_Shape,
      tol,
    );
    trash.push(fitter);
    if (!fitter.IsDone()) {
      throw new Error("surfaceFromPoints: B-spline surface fit failed");
    }
    const hBSpline = fitter.Surface();
    trash.push(hBSpline);
    if (hBSpline.IsNull()) {
      throw new Error("surfaceFromPoints: fit produced a null surface handle");
    }
    // Upcast Handle_Geom_BSplineSurface → Handle_Geom_Surface for MakeFace_8.
    const hSurf = new oc.Handle_Geom_Surface_2(hBSpline.get());
    trash.push(hSurf);

    const faceMaker = new oc.BRepBuilderAPI_MakeFace_8(hSurf, tol);
    trash.push(faceMaker);
    if (!faceMaker.IsDone()) {
      throw new Error("surfaceFromPoints: MakeFace failed on the fitted surface");
    }
    const face = faceMaker.Face();
    if (face.IsNull()) {
      face.delete();
      throw new Error("surfaceFromPoints: produced an empty face");
    }
    return new Solid(oc, face);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Offset a face/shell by `distance` metres (`BRepOffset_MakeSimpleOffset`).
 * Returns the offset skin (still a sheet body), not a solid — use
 * {@link thicken} for a plate of wall thickness.
 */
export function offsetSurface(oc: Occt, surface: Solid, distance: number): Solid {
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error(`offsetSurface: distance must be a finite non-zero number (got ${distance})`);
  }
  const maker = new oc.BRepOffset_MakeSimpleOffset_2(surface.shape, distance);
  try {
    // Offset skin only — do not build a solid (thicken owns that path).
    maker.SetBuildSolidFlag(false);
    maker.Perform();
    if (!maker.IsDone()) {
      throw new Error("offsetSurface: MakeSimpleOffset did not complete");
    }
    const shape = maker.GetResultShape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("offsetSurface: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
  }
}

/**
 * Fill a closed boundary of edges into a single face (`BRepOffsetAPI_MakeFilling`).
 *
 * Boundary edges must form a loop (shared endpoints). Continuity defaults to C0
 * position constraints, matching the reconstruct service freeform path.
 */
/**
 * Keep one side of a body split by a tool plane (§14 `trimSurface`).
 *
 * Delegates to {@link split}; `keep: "positive"` (default) retains the lump whose
 * centre of mass has the larger signed distance to the plane; `"negative"` keeps
 * the smaller. Caller owns the returned Solid; other lumps are freed.
 */
export function trimSurface(
  oc: Occt,
  body: Solid,
  plane: DatumPlane,
  opts?: { keep?: "positive" | "negative" },
): Solid {
  const n = plane.normal;
  const nLen = Math.hypot(n[0], n[1], n[2]);
  if (!Number.isFinite(nLen) || nLen === 0) {
    throw new Error("trimSurface: plane normal must be a non-zero finite vector");
  }
  const unit: Vec3 = [n[0] / nLen, n[1] / nLen, n[2] / nLen];
  const origin = plane.origin;
  const parts = split(oc, body, plane);
  if (parts.length === 0) {
    throw new Error("trimSurface: split produced no parts");
  }
  const keep = opts?.keep ?? "positive";
  let bestIdx = 0;
  let bestScore = (() => {
    const c = parts[0]!.centreOfMass();
    return (
      (c[0] - origin[0]) * unit[0] + (c[1] - origin[1]) * unit[1] + (c[2] - origin[2]) * unit[2]
    );
  })();
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i]!.centreOfMass();
    const score =
      (c[0] - origin[0]) * unit[0] + (c[1] - origin[1]) * unit[1] + (c[2] - origin[2]) * unit[2];
    if (keep === "positive" ? score > bestScore : score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const best = parts[bestIdx]!;
  for (let i = 0; i < parts.length; i++) {
    if (i !== bestIdx) parts[i]!.delete();
  }
  return best;
}

/**
 * Restore a trimmed B-spline face to the full natural bounds of its basis
 * surface. The input must contain exactly one B-spline face; analytic surfaces
 * such as planes are intentionally rejected because they are unbounded and have
 * no finite natural face to restore.
 */
export function untrimSurface(oc: Occt, body: Solid): Solid {
  const face = singleFace(oc, body, "untrimSurface");
  const adaptor = new oc.BRepAdaptor_Surface_2(face, false);
  const trash: Array<{ delete(): void }> = [face, adaptor];
  try {
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) {
      throw new Error("untrimSurface: the face basis must be a bounded B-spline surface");
    }
    const bspline = adaptor.BSpline();
    trash.push(bspline);
    if (bspline.IsNull()) {
      throw new Error("untrimSurface: the face has a null B-spline basis");
    }
    const surface = new oc.Handle_Geom_Surface_2(bspline.get());
    trash.push(surface);
    return faceFromNaturalBounds(oc, surface, "untrimSurface", trash);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Extend one selected boundary of a single B-spline face by `length` metres.
 * The edge's stored p-curve endpoints identify U/V and before/after exactly;
 * OCCT then extends a copy of the basis surface with C1..C3 continuity, leaving
 * the source body unchanged.
 */
export function extendSurface(
  oc: Occt,
  body: Solid,
  boundary: TopoDS_Edge,
  length: number,
  opts?: ExtendSurfaceOptions,
): Solid {
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`extendSurface: length must be a finite positive number (got ${length})`);
  }
  const continuity = opts?.continuity ?? 1;
  if (continuity !== 1 && continuity !== 2 && continuity !== 3) {
    throw new Error(`extendSurface: continuity must be 1, 2, or 3 (got ${continuity})`);
  }

  const face = singleFace(oc, body, "extendSurface");
  const restricted = new oc.BRepAdaptor_Surface_2(face, true);
  const basis = new oc.BRepAdaptor_Surface_2(face, false);
  const trash: Array<{ delete(): void }> = [face, restricted, basis];
  try {
    if (basis.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) {
      throw new Error("extendSurface: the face basis must be a bounded B-spline surface");
    }
    const side = boundarySide(oc, face, boundary, restricted, trash);
    const bspline = basis.BSpline();
    trash.push(bspline);
    if (bspline.IsNull()) {
      throw new Error("extendSurface: the face has a null B-spline basis");
    }
    const bounded = new oc.Handle_Geom_BoundedSurface_2(bspline.get());
    trash.push(bounded);
    oc.GeomLib.ExtendSurfByLength(bounded, length, continuity, side.direction === "u", side.after);
    if (bounded.IsNull()) {
      throw new Error("extendSurface: OCCT returned a null extended surface");
    }
    const surface = new oc.Handle_Geom_Surface_2(bounded.get());
    trash.push(surface);
    return faceFromNaturalBounds(oc, surface, "extendSurface", trash);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

export function patch(oc: Occt, boundary: readonly TopoDS_Edge[], opts?: PatchOptions): Solid {
  if (boundary.length < 3) {
    throw new Error("patch: needs at least 3 boundary edges");
  }

  const continuity = continuityToGeomAbs(oc, opts?.continuity ?? "c0");
  // Defaults mirror BRepOffsetAPI_MakeFilling's usual construction parameters.
  const fill = new oc.BRepOffsetAPI_MakeFilling(
    3, // Degree
    15, // NbPtsOnCur
    2, // NbIter
    false, // Anisotropie
    1e-5, // Tol2d
    1e-4, // Tol3d
    0.01, // TolAng
    0.1, // TolCurv
    8, // MaxDeg
    9, // MaxSegments
  );
  const progress = new oc.Message_ProgressRange_1();
  const trash: Array<{ delete(): void }> = [fill, progress];
  try {
    for (const e of boundary) {
      fill.Add_1(e, continuity, true);
    }
    if (opts?.passthroughPoints) {
      for (const p of opts.passthroughPoints) {
        const gp = new oc.gp_Pnt_3(p[0], p[1], p[2]);
        trash.push(gp);
        fill.Add_4(gp);
      }
    }
    fill.Build(progress);
    if (!fill.IsDone()) {
      throw new Error("patch: MakeFilling failed to build a face");
    }
    const shape = fill.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("patch: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function continuityToGeomAbs(oc: Occt, c: NonNullable<PatchOptions["continuity"]>): GeomAbs_Shape {
  const G = oc.GeomAbs_Shape;
  switch (c) {
    case "c1":
    case "g1":
      return G.GeomAbs_G1 as unknown as GeomAbs_Shape;
    case "c2":
    case "g2":
      return G.GeomAbs_G2 as unknown as GeomAbs_Shape;
    case "c0":
    default:
      return G.GeomAbs_C0 as unknown as GeomAbs_Shape;
  }
}

function singleFace(oc: Occt, body: Solid, operation: string): TopoDS_Face {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(body.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  try {
    if (!exp.More()) throw new Error(`${operation}: the body contains no face`);
    const face = oc.TopoDS.Face_1(exp.Current());
    exp.Next();
    if (exp.More()) {
      face.delete();
      throw new Error(`${operation}: the body must contain exactly one face`);
    }
    return face;
  } finally {
    exp.delete();
  }
}

function faceFromNaturalBounds(
  oc: Occt,
  surface: Handle_Geom_Surface,
  operation: string,
  trash: Array<{ delete(): void }>,
): Solid {
  const maker = new oc.BRepBuilderAPI_MakeFace_8(surface, 1e-7);
  trash.push(maker);
  if (!maker.IsDone()) {
    throw new Error(`${operation}: MakeFace failed on the B-spline surface`);
  }
  const face = maker.Face();
  if (face.IsNull()) {
    face.delete();
    throw new Error(`${operation}: produced an empty face`);
  }
  return new Solid(oc, face);
}

function boundarySide(
  oc: Occt,
  face: TopoDS_Face,
  edge: TopoDS_Edge,
  surface: BRepAdaptor_Surface,
  trash: Array<{ delete(): void }>,
): { direction: "u" | "v"; after: boolean } {
  const first = new oc.gp_Pnt2d_1();
  const last = new oc.gp_Pnt2d_1();
  trash.push(first, last);
  oc.BRep_Tool.UVPoints_2(edge, face, first, last);

  const u0 = surface.FirstUParameter();
  const u1 = surface.LastUParameter();
  const v0 = surface.FirstVParameter();
  const v1 = surface.LastVParameter();
  const scale = Math.max(1, Math.abs(u1 - u0), Math.abs(v1 - v0));
  const tolerance = scale * 1e-7;
  const candidates = [
    {
      direction: "u" as const,
      after: false,
      error: Math.abs(first.X() - u0) + Math.abs(last.X() - u0),
    },
    {
      direction: "u" as const,
      after: true,
      error: Math.abs(first.X() - u1) + Math.abs(last.X() - u1),
    },
    {
      direction: "v" as const,
      after: false,
      error: Math.abs(first.Y() - v0) + Math.abs(last.Y() - v0),
    },
    {
      direction: "v" as const,
      after: true,
      error: Math.abs(first.Y() - v1) + Math.abs(last.Y() - v1),
    },
  ].sort((a, b) => a.error - b.error);
  const best = candidates[0]!;
  if (best.error > 2 * tolerance) {
    throw new Error("extendSurface: the selected edge is not a boundary of the face");
  }
  return { direction: best.direction, after: best.after };
}
