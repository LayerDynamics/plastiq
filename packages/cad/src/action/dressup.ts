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
import { ownedMakerHistory, type OwnedShapeHistory } from "../mesh/remap.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";

export type { OwnedShapeHistory };

/**
 * Solid + optional maker-backed shape history for §13.1 faceIdRemap.
 *
 * Dress-up makers expose `{Modified, Generated, IsDeleted}` through their
 * BRepBuilderAPI_MakeShape base (not a BRepTools_History handle). History is
 * adapted IsDeleted→IsRemoved and keeps the maker alive until
 * `history.delete()`.
 */
export type DressupResult = {
  solid: Solid;
  history?: OwnedShapeHistory;
};

export interface FilletOptions {
  /**
   * End radius for a variable-radius fillet along each edge (SI metres).
   * When set (and ≠ `radius`), uses OCCT Add_3(R1, R2, edge) (T20 / C10a).
   */
  readonly endRadius?: number;
}

/**
 * Round the picked edges of `base` to `radius` (SI metres). Optional endRadius →
 * variable fillet. Returns only the solid (maker freed) — use
 * {@link filletWithHistory} when faceIdRemap needs the maker's history.
 */
export function fillet(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  radius: number,
  opts?: FilletOptions,
): Solid {
  const r = filletWithHistory(oc, base, edges, radius, opts);
  r.history?.delete();
  return r.solid;
}

/**
 * Fillet that retains maker-backed shape history for §13.1 faceIdRemap.
 * Caller MUST `history?.delete()` after remap (frees the BRepFilletAPI_MakeFillet).
 */
export function filletWithHistory(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  radius: number,
  opts?: FilletOptions,
): DressupResult {
  // K7 — magnitude pre-validation (mirrors revolve.ts:20-38). A non-finite, zero,
  // or negative radius reaches OCCT and dies as an unreadable raw-pointer
  // Standard_Failure; reject it here with a NAMED error, before allocating the
  // maker (so there is nothing to free on the reject).
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`fillet: radius must be a finite positive number (got ${radius})`);
  }
  const endR = opts?.endRadius;
  if (endR != null && (!Number.isFinite(endR) || endR <= 0)) {
    throw new Error(`fillet: endRadius must be a finite positive number when set (got ${endR})`);
  }
  const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
  const maker = new oc.BRepFilletAPI_MakeFillet(base.shape, shapeType);
  // endR is now known finite & positive when present, so the variable-radius
  // branch only needs it to DIFFER from the constant radius.
  const variable = endR != null && endR !== radius;
  // On failure free the maker here. On success ownership moves to history (or
  // is freed immediately when history methods are uncallable).
  let transferred = false;
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
    const solid = new Solid(oc, shape);
    // Maker history: Modified/Generated/IsDeleted are pinned callable in
    // oc/history.pin.test.ts. Keep the maker alive for queries.
    if (
      typeof maker.Modified === "function" &&
      typeof maker.Generated === "function" &&
      typeof maker.IsDeleted === "function"
    ) {
      transferred = true;
      return { solid, history: ownedMakerHistory(maker) };
    }
    return { solid };
  } finally {
    if (!transferred) maker.delete();
  }
}

/**
 * Linear start→end radius for {@link filletLaw} (SI metres).
 *
 * Intended as a continuous `Law_Linear` over edge parameter 0→1
 * (`MakeFillet.Add_4`). Measured against the current trimmed wasm: `Law_Linear`
 * constructs and `Value()` works, and `Add_4` accepts a `Handle_Law_Function`,
 * but the subsequent fillet build (`Shape()`) always raises `Standard_Failure`
 * — even for a constant law. So this API is delivered as the honest discrete
 * two-radius approximation (`Add_3`), identical to {@link fillet}'s
 * `{ endRadius }` path. See `dressup.filletLaw.test.ts` for the pin.
 */
export interface FilletLawLinear {
  readonly kind?: "linear";
  readonly startRadius: number;
  readonly endRadius: number;
}

/**
 * Variable-radius fillet (FablesFindings §13.2 `filletLaw`).
 *
 * **Delivery status:** continuous law-driven fillet via `Law_Linear` +
 * `MakeFillet.Add_4` is **uncallable for geometry** in this embind build (pin in
 * `dressup.filletLaw.test.ts`). This function therefore implements the discrete
 * multi-radius approximation: `BRepFilletAPI_MakeFillet.Add_3(start, end, edge)`
 * — the same route as {@link fillet}`(…, { endRadius })`.
 *
 * When a future trim/fix makes `Add_4` + `Shape()` succeed, swap the body to
 * the law path without changing this signature.
 */
export function filletLaw(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  law: FilletLawLinear,
): Solid {
  const r1 = law.startRadius;
  const r2 = law.endRadius;
  if (!Number.isFinite(r1) || r1 <= 0) {
    throw new Error(`filletLaw: startRadius must be a finite positive number (got ${r1})`);
  }
  if (!Number.isFinite(r2) || r2 <= 0) {
    throw new Error(`filletLaw: endRadius must be a finite positive number (got ${r2})`);
  }
  // Honest partial delivery: Add_3 two-radius (not Add_4 law — see pin tests).
  return fillet(oc, base, edges, r1, { endRadius: r2 });
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

/**
 * Chamfer the picked edges of `base` by setback `distance` (symmetric unless opts).
 * Returns only the solid — use {@link chamferWithHistory} for §13.1 remap.
 */
export function chamfer(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  distance: number,
  opts?: ChamferOptions,
): Solid {
  const r = chamferWithHistory(oc, base, edges, distance, opts);
  r.history?.delete();
  return r.solid;
}

/**
 * Chamfer that retains maker-backed shape history for §13.1 faceIdRemap.
 * Caller MUST `history?.delete()` after remap (frees the BRepFilletAPI_MakeChamfer).
 */
export function chamferWithHistory(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  distance: number,
  opts?: ChamferOptions,
): DressupResult {
  // K7 — magnitude pre-validation (mirrors revolve.ts:20-38): reject a non-finite,
  // zero, or negative setback before it reaches OCCT as an opaque failure. Done
  // before allocating the maker so a reject leaves nothing to clean up.
  if (!Number.isFinite(distance) || distance <= 0) {
    throw new Error(`chamfer: distance must be a finite positive number (got ${distance})`);
  }
  const d2 = opts?.distance2;
  if (d2 != null && (!Number.isFinite(d2) || d2 <= 0)) {
    throw new Error(`chamfer: distance2 must be a finite positive number when set (got ${d2})`);
  }
  // K1 — an asymmetric (two-distance) chamfer is defined as `distance` on `face`
  // and `distance2` on the adjacent face; without a face OCCT has nowhere to
  // measure the second setback, so the old code SILENTLY fell back to a symmetric
  // chamfer via Add_2 and reported success. Refuse the ambiguous request instead
  // of quietly degrading an asymmetric-chamfer ask to a symmetric result.
  if (d2 != null && opts?.face == null) {
    throw new Error("chamfer: distance2 requires a face to apply it to");
  }
  const maker = new oc.BRepFilletAPI_MakeChamfer(base.shape);
  // After the K1 guard, a present d2 always has a face; the two-distance path is
  // taken only when the two setbacks actually differ.
  const twoDist = d2 != null && d2 !== distance && opts?.face != null;
  // On failure free the maker; on success transfer ownership to history when
  // Modified/Generated/IsDeleted are callable.
  let transferred = false;
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
      const solid = new Solid(oc, shape);
      if (
        typeof maker.Modified === "function" &&
        typeof maker.Generated === "function" &&
        typeof maker.IsDeleted === "function"
      ) {
        transferred = true;
        return { solid, history: ownedMakerHistory(maker) };
      }
      return { solid };
    } finally {
      face?.delete();
    }
  } finally {
    if (!transferred) maker.delete();
  }
}

export interface ShellOptions {
  /**
   * Offset direction of the wall thickness.
   * - `inward` (default): hollow the solid, wall of `thickness` (negative OCCT offset).
   * - `outward`: grow walls outward (positive OCCT offset) (G13).
   */
  readonly direction?: "inward" | "outward";
  /**
   * Offset/self-intersection tolerance handed to MakeThickSolidByJoin (SI metres).
   * Defaults to {@link SHELL_TOLERANCE_DEFAULT} (K2). Override for very small or
   * very large features whose scale the default does not suit.
   */
  readonly tolerance?: number;
}

/**
 * Default offset tolerance for {@link shell} (SI metres) — K2.
 *
 * The op long hardcoded `1e-3` m (1 mm): three orders COARSER than the kernel's
 * own `1e-7` m boolean fuzzy contract (action/boolean.ts:77), and boolean.ts:72
 * itself cites that 1 mm value as a defect. `1e-5` m (10 µm) is the justified
 * default — three orders finer than 1 mm, far closer to the 1e-7 fuzzy contract —
 * while staying coarse enough that BRepOffsetAPI_MakeThickSolid's offset solver
 * stays robust on real parts (pushing all the way to the fuzzy 1e-7 makes the
 * thick-solid intersection fragile on non-trivial faces). Callers override via
 * {@link ShellOptions.tolerance}.
 */
const SHELL_TOLERANCE_DEFAULT = 1e-5;

/** Hollow `base` to a wall `thickness`, opening the picked faces. */
export function shell(
  oc: Occt,
  base: Solid,
  faces: readonly FaceRef[],
  thickness: number,
  opts?: ShellOptions,
): Solid {
  const r = shellWithHistory(oc, base, faces, thickness, opts);
  r.history?.delete();
  return r.solid;
}

/** Shell that retains maker-backed shape history for §13.1 faceIdRemap. */
export function shellWithHistory(
  oc: Occt,
  base: Solid,
  faces: readonly FaceRef[],
  thickness: number,
  opts?: ShellOptions,
): DressupResult {
  // K7 — magnitude pre-validation (mirrors revolve.ts:20-38). Reject a non-finite,
  // zero, or negative wall thickness before OCCT turns it into an opaque
  // raw-pointer failure; the offset SIGN is chosen from `direction` below, so
  // `thickness` is always a positive magnitude here.
  if (!Number.isFinite(thickness) || thickness <= 0) {
    throw new Error(`shell: thickness must be a finite positive number (got ${thickness})`);
  }
  // K2 — the offset/self-intersection tolerance, now an option (was hardcoded 1e-3).
  const tolerance = opts?.tolerance ?? SHELL_TOLERANCE_DEFAULT;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error(`shell: tolerance must be a finite positive number (got ${tolerance})`);
  }
  const list = new oc.TopTools_ListOfShape_1();
  const resolved: TopoDS_Face[] = [];
  const maker = new oc.BRepOffsetAPI_MakeThickSolid();
  const progress = new oc.Message_ProgressRange_1();
  let transferred = false;
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
    // Negative offset hollows inward (outer envelope ≈ original). Positive
    // grows walls outward (outer envelope expands by ~thickness). Outward
    // needs Intersection join + the Intersection flag — Arc join with a
    // positive offset commonly raises Standard_Failure on simple boxes (G13).
    const outward = (opts?.direction ?? "inward") === "outward";
    const offset = outward ? thickness : -thickness;
    const join = (outward
      ? oc.GeomAbs_JoinType.GeomAbs_Intersection
      : oc.GeomAbs_JoinType.GeomAbs_Arc) as unknown as GeomAbs_JoinType;
    maker.MakeThickSolidByJoin(
      base.shape,
      list,
      offset,
      tolerance,
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
    const solid = new Solid(oc, shape);
    transferred = true;
    return { solid, history: ownedMakerHistory(maker) };
  } finally {
    if (!transferred) maker.delete();
    progress.delete();
    for (const f of resolved) f.delete();
    list.delete();
  }
}

export interface DraftOptions {
  /**
   * A single face to taper. Back-compat alias for `faces: [face]` — a caller that
   * passes only `face` (the app does today) keeps working unchanged. Provide
   * either `face` or `faces`; when both are given, `faces` wins and `face` is
   * ignored (§13.2 — the single-face limit was app-side, not an OCCT limit).
   */
  readonly face?: FaceRef;
  /**
   * One or more faces to taper about the SHARED neutral plane / pull direction /
   * angle. Each is added to one `BRepOffsetAPI_DraftAngle` build via `.Add`, so
   * the whole mold draft is a single kernel operation (not a sequence of solids).
   */
  readonly faces?: readonly FaceRef[];
  /** Pull (mold-release) direction. */
  readonly pullDirection: Vec3;
  readonly neutralOrigin: Vec3;
  readonly neutralNormal: Vec3;
  /** Taper angle in radians. */
  readonly angle: number;
}

/** Taper the picked face(s) of `base` about a neutral plane (mold draft). */
export function draft(oc: Occt, base: Solid, opts: DraftOptions): Solid {
  const r = draftWithHistory(oc, base, opts);
  r.history?.delete();
  return r.solid;
}

/** Draft that retains maker-backed shape history for §13.1 faceIdRemap. */
export function draftWithHistory(oc: Occt, base: Solid, opts: DraftOptions): DressupResult {
  // Normalize the single/multi inputs to one non-empty face list. `faces` wins
  // when present; otherwise the back-compat single `face` becomes a one-element
  // list. Every face shares the neutral plane, pull direction, and angle.
  const faceRefs: readonly FaceRef[] = opts.faces ?? (opts.face != null ? [opts.face] : []);
  if (faceRefs.length === 0) throw new Error("draft: no face selected");

  const da = new oc.BRepOffsetAPI_DraftAngle_2(base.shape);
  const dir = new oc.gp_Dir_4(opts.pullDirection[0], opts.pullDirection[1], opts.pullDirection[2]);
  const origin = new oc.gp_Pnt_3(
    opts.neutralOrigin[0],
    opts.neutralOrigin[1],
    opts.neutralOrigin[2],
  );
  const normal = new oc.gp_Dir_4(
    opts.neutralNormal[0],
    opts.neutralNormal[1],
    opts.neutralNormal[2],
  );
  const plane = new oc.gp_Pln_3(origin, normal);
  const progress = new oc.Message_ProgressRange_1();
  // Every resolved face is freed on EVERY exit (incl. a Standard_Failure from
  // `Add`/`Build`/`Shape`). Faces stay alive until the finally — after Build and
  // Shape have consumed them — mirroring the single-face lifetime discipline.
  const resolved: TopoDS_Face[] = [];
  let transferred = false;
  try {
    for (const ref of faceRefs) {
      const face = resolveFaceRef(oc, base, ref);
      if (face) {
        resolved.push(face);
        da.Add(face, dir, opts.angle, plane, true);
      }
    }
    // Every requested face must resolve. Drafting only the subset that resolved
    // would silently return partial geometry (the un-tapered faces) as a success
    // — the same all-must-resolve contract the other dress-ups enforce.
    if (resolved.length < faceRefs.length) {
      throw new Error(
        `draft: ${faceRefs.length - resolved.length} of ${faceRefs.length} selected face(s) did not resolve on the current body`,
      );
    }
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
    const solid = new Solid(oc, shape);
    transferred = true;
    return { solid, history: ownedMakerHistory(da) };
  } finally {
    if (!transferred) da.delete();
    plane.delete();
    normal.delete();
    origin.delete();
    dir.delete();
    for (const f of resolved) f.delete();
    progress.delete();
  }
}
