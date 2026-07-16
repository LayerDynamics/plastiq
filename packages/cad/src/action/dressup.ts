// Dress-up operations: fillet / chamfer / shell / draft. Each consumes persistent
// EdgeRef/FaceRef selections, re-resolving them against `base`'s current topology
// (SPEC-4 FR-16) so a dress-up survives an upstream parametric rebuild.

import type {
  ChFi3d_FilletShape,
  BRepOffset_Mode,
  GeomAbs_JoinType,
  TopoDS_Face,
} from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import { resolveEdgeRef, resolveFaceRef } from "../mesh/resolve.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";

export interface FilletOptions {
  /**
   * End radius for a variable-radius fillet along each edge (SI metres).
   * When set (and ≠ `radius`), uses OCCT Add_3(R1, R2, edge) (T20 / C10a).
   */
  readonly endRadius?: number;
}

/** Round the picked edges of `base` to `radius` (SI metres). Optional endRadius → variable fillet. */
export function fillet(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  radius: number,
  opts?: FilletOptions,
): Solid {
  const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
  const maker = new oc.BRepFilletAPI_MakeFillet(base.shape, shapeType);
  const endR = opts?.endRadius;
  const variable = endR != null && Number.isFinite(endR) && endR !== radius;
  // The maker is freed on EVERY exit — incl. a Standard_Failure thrown by `Add_2`
  // or `Shape()` (a fillet radius the local geometry can't absorb is reachable in
  // normal editing) — so a failed fillet doesn't leak it in the long-lived worker.
  try {
    let added = 0;
    for (const ref of edges) {
      const edge = resolveEdgeRef(oc, base, ref);
      if (edge) {
        try {
          if (variable) maker.Add_3(radius, endR!, edge);
          else maker.Add_2(radius, edge);
        } finally {
          edge.delete();
        }
        added++;
      }
    }
    // Every requested edge must resolve. Filleting only the subset that resolved
    // would silently return partial geometry (the missing edges un-rounded) as a
    // success — exactly the case an upstream rebuild can perturb. Fail loudly so
    // the feature is marked errored instead.
    if (edges.length === 0 || added < edges.length) {
      throw new Error(
        edges.length === 0
          ? "fillet: no edges selected"
          : `fillet: ${edges.length - added} of ${edges.length} selected edge(s) did not resolve on the current body`,
      );
    }
    const shape = maker.Shape();
    // The null `Shape()` handle is itself an owned allocation — free it before the
    // throw. On success the returned Solid owns it, so it is freed exactly once.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("fillet: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
  }
}

export interface ChamferOptions {
  /**
   * Second setback for a two-distance chamfer (SI metres). Requires `face` —
   * the face on which `distance` is measured (OCCT Add_3) (T20 / C10a).
   */
  readonly distance2?: number;
  /** Face adjacent to the edges for two-distance chamfer. */
  readonly face?: FaceRef;
}

/** Chamfer the picked edges of `base` by setback `distance` (symmetric unless opts). */
export function chamfer(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  distance: number,
  opts?: ChamferOptions,
): Solid {
  const maker = new oc.BRepFilletAPI_MakeChamfer(base.shape);
  const d2 = opts?.distance2;
  const twoDist =
    d2 != null && Number.isFinite(d2) && d2 !== distance && opts?.face != null;
  // Free the maker on every exit, including a Standard_Failure from `Add_2`/`Shape`
  // — see the note in `fillet`.
  try {
    let face: TopoDS_Face | null = null;
    if (twoDist) {
      face = resolveFaceRef(oc, base, opts!.face!);
      if (!face) throw new Error("chamfer: two-distance face did not resolve on the current body");
    }
    try {
      let added = 0;
      for (const ref of edges) {
        const edge = resolveEdgeRef(oc, base, ref);
        if (edge) {
          try {
            if (twoDist && face) maker.Add_3(distance, d2!, edge, face);
            else maker.Add_2(distance, edge);
          } finally {
            edge.delete();
          }
          added++;
        }
      }
      // Every requested edge must resolve — see the note in `fillet`. Chamfering only
      // the subset that resolved would silently return partial geometry as success.
      if (edges.length === 0 || added < edges.length) {
        throw new Error(
          edges.length === 0
            ? "chamfer: no edges selected"
            : `chamfer: ${edges.length - added} of ${edges.length} selected edge(s) did not resolve on the current body`,
        );
      }
      // BRepFilletAPI_MakeChamfer.IsDone() may stay false until Shape() builds; guard
      // on a non-null result instead. The null handle is freed before the throw.
      const shape = maker.Shape();
      if (shape.IsNull()) {
        shape.delete();
        throw new Error("chamfer: produced an empty shape");
      }
      return new Solid(oc, shape);
    } finally {
      face?.delete();
    }
  } finally {
    maker.delete();
  }
}

export interface ShellOptions {
  /**
   * Offset direction of the wall thickness.
   * - `inward` (default): hollow the solid, wall of `thickness` (negative OCCT offset).
   * - `outward`: grow walls outward (positive OCCT offset) (G13).
   */
  readonly direction?: "inward" | "outward";
}

/** Hollow `base` to a wall `thickness`, opening the picked faces. */
export function shell(
  oc: Occt,
  base: Solid,
  faces: readonly FaceRef[],
  thickness: number,
  opts?: ShellOptions,
): Solid {
  const list = new oc.TopTools_ListOfShape_1();
  const resolved: TopoDS_Face[] = [];
  // The face list and every resolved face are freed on EVERY exit (incl. a
  // Standard_Failure from MakeThickSolidByJoin — a wall thicker than the part can
  // absorb is reachable in normal editing), so a failed shell leaks nothing.
  try {
    for (const ref of faces) {
      const f = resolveFaceRef(oc, base, ref);
      if (f) {
        list.Append_1(f);
        resolved.push(f);
      }
    }
    // Every requested open-face must resolve. Shelling with fewer openings than
    // asked changes the result's topology (e.g. an enclosed cavity instead of an
    // open-top shell) — fail loudly rather than returning the wrong solid as success.
    if (faces.length === 0 || resolved.length < faces.length) {
      throw new Error(
        faces.length === 0
          ? "shell: no faces selected"
          : `shell: ${faces.length - resolved.length} of ${faces.length} selected face(s) did not resolve on the current body`,
      );
    }
    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    const progress = new oc.Message_ProgressRange_1();
    try {
      // Negative offset hollows inward (outer envelope ≈ original). Positive
      // grows walls outward (outer envelope expands by ~thickness). Outward
      // needs Intersection join + the Intersection flag — Arc join with a
      // positive offset commonly raises Standard_Failure on simple boxes (G13).
      const outward = (opts?.direction ?? "inward") === "outward";
      const offset = outward ? thickness : -thickness;
      const join = (
        outward
          ? oc.GeomAbs_JoinType.GeomAbs_Intersection
          : oc.GeomAbs_JoinType.GeomAbs_Arc
      ) as unknown as GeomAbs_JoinType;
      maker.MakeThickSolidByJoin(
        base.shape,
        list,
        offset,
        1e-3,
        oc.BRepOffset_Mode.BRepOffset_Skin as unknown as BRepOffset_Mode,
        outward, // Intersection processing — required for reliable positive offsets
        false,
        join,
        false,
        progress,
      );
      const shape = maker.Shape();
      // The null `Shape()` handle is itself an owned allocation — free it before the
      // throw. On success the returned Solid owns it, so it is freed exactly once.
      if (shape.IsNull()) {
        shape.delete();
        throw new Error("shell: produced an empty shape");
      }
      return new Solid(oc, shape);
    } finally {
      maker.delete();
      progress.delete();
    }
  } finally {
    for (const f of resolved) f.delete();
    list.delete();
  }
}

export interface DraftOptions {
  readonly face: FaceRef;
  /** Pull (mold-release) direction. */
  readonly pullDirection: Vec3;
  readonly neutralOrigin: Vec3;
  readonly neutralNormal: Vec3;
  /** Taper angle in radians. */
  readonly angle: number;
}

/** Taper the picked face of `base` about a neutral plane (mold draft). */
export function draft(oc: Occt, base: Solid, opts: DraftOptions): Solid {
  const face = resolveFaceRef(oc, base, opts.face);
  if (!face) throw new Error("draft: the selected face did not resolve on the current body");

  const da = new oc.BRepOffsetAPI_DraftAngle_2(base.shape);
  const dir = new oc.gp_Dir_4(opts.pullDirection[0], opts.pullDirection[1], opts.pullDirection[2]);
  const origin = new oc.gp_Pnt_3(opts.neutralOrigin[0], opts.neutralOrigin[1], opts.neutralOrigin[2]);
  const normal = new oc.gp_Dir_4(opts.neutralNormal[0], opts.neutralNormal[1], opts.neutralNormal[2]);
  const plane = new oc.gp_Pln_3(origin, normal);
  const progress = new oc.Message_ProgressRange_1();
  try {
    da.Add(face, dir, opts.angle, plane, true);
    da.Build(progress);
    if (!da.IsDone()) throw new Error("draft: the taper could not be applied");
    const shape = da.Shape();
    // The null `Shape()` handle is an owned allocation; free it before the throw.
    // (`da` and the gp_* temporaries are freed by the finally; on success the
    // returned Solid owns `shape`, so it is freed exactly once.)
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("draft: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    da.delete();
    plane.delete();
    normal.delete();
    origin.delete();
    dir.delete();
    face.delete();
    progress.delete();
  }
}
