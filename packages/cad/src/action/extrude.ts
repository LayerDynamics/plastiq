// Extrude (linear prism) of a sketch profile.

import type { TopoDS_Face, TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { dot, normalize, scale, sub } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { resolveFaceRef } from "../mesh/resolve.js";
import { faceNormal, MESH_PURPOSE, nodeWorld, shapeEnums } from "../mesh/normals.js";
import type { FaceRef } from "../mesh/tagged.js";
import { intersect, subtract } from "./boolean.js";

export interface ExtrudeOptions {
  /** Extrude this far in the OPPOSITE direction too (two-sided pad). */
  readonly back?: number;
  /** Override the extrude direction (default: the sketch plane normal). */
  readonly direction?: Vec3;
}

/** Shift a shape by `delta`, returning an independent copy. */
function shifted(oc: Occt, shape: TopoDS_Shape, delta: Vec3): TopoDS_Shape {
  const trsf = new oc.gp_Trsf_1();
  const v = new oc.gp_Vec_4(delta[0], delta[1], delta[2]);
  trsf.SetTranslation_1(v);
  const t = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
  const out = t.Shape();
  t.delete();
  v.delete();
  trsf.delete();
  return out;
}

/**
 * Extrude a sketch profile by `height` (SI metres) along the plane normal (or
 * `opts.direction`). With `opts.back`, also extrude that far the other way for a
 * symmetric two-sided pad.
 */
export function extrude(
  oc: Occt,
  sketch: Sketch,
  height: number,
  opts?: ExtrudeOptions,
): Solid {
  const dir = normalize(opts?.direction ?? sketch.plane.normal);
  const back = opts?.back ?? 0;
  // A zero total sweep distance makes a degenerate (zero-thickness) prism that
  // OCCT would hand back as an invalid shape — reject it rather than returning one.
  if (!Number.isFinite(height + back) || height + back === 0) {
    throw new Error("extrude: total height (height + back) must be non-zero");
  }
  const face = sketch.toFace(oc);

  let baseFace = face;
  if (back !== 0) {
    baseFace = shifted(oc, face, scale(dir, -back));
    face.delete();
  }

  const total = height + back;
  const ext = scale(dir, total);
  const v = new oc.gp_Vec_4(ext[0], ext[1], ext[2]);
  const prism = new oc.BRepPrimAPI_MakePrism_1(baseFace, v, false, true);
  const shape = prism.Shape();
  prism.delete();
  v.delete();
  baseFace.delete();
  // Guard the result for parity with loft/sweep/dress-up: reject a null shape
  // rather than wrapping an empty Solid and returning it as a success.
  if (shape.IsNull()) {
    shape.delete();
    throw new Error("extrude: produced an empty shape");
  }
  return new Solid(oc, shape);
}

export interface ExtrudeToFaceOptions {
  /** Override the extrude direction (default: the sketch plane normal). */
  readonly direction?: Vec3;
}

/** Planarity tolerance: a face whose triangulation nodes all lie within this
 * distance of its (centroid, normal) plane is treated as planar. Matches OCCT's
 * Precision::Confusion (0.1 µm) — a planar face's mesh nodes sit exactly on its
 * plane, while any modelling-relevant curvature deviates by far more. */
const PLANAR_TOL = 1e-7;

/** The 8 corner points of an axis-aligned bounding box. */
function bboxCorners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

/** Max distance of the face's triangulation nodes from the plane (point, normal). */
function maxPlaneDeviation(oc: Occt, face: TopoDS_Face, point: Vec3, normal: Vec3): number {
  const loc = new oc.TopLoc_Location_1();
  const handle = oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE);
  try {
    if (handle.IsNull()) {
      // resolveFaceRef meshed the body before matching, so a missing
      // triangulation is a violated invariant — fail loudly rather than guess
      // the face's shape class.
      throw new Error(
        "extrudeToFace: the target face has no triangulation to classify it as planar or curved",
      );
    }
    const tri = handle.get();
    const identity = loc.IsIdentity();
    const trsf = loc.Transformation();
    try {
      let worst = 0;
      const nb = tri.NbNodes();
      for (let i = 1; i <= nb; i++) {
        const p = nodeWorld(tri, i, identity, trsf);
        const d = Math.abs(dot(sub(p, point), normal));
        if (d > worst) worst = d;
      }
      return worst;
    } finally {
      trsf.delete();
    }
  } finally {
    handle.delete();
    loc.delete();
  }
}

/** Sweep a face by `delta` into a solid trim tool (caller owns the result). */
function facePrism(oc: Occt, face: TopoDS_Face, delta: Vec3): Solid {
  const v = new oc.gp_Vec_4(delta[0], delta[1], delta[2]);
  try {
    const prism = new oc.BRepPrimAPI_MakePrism_1(face, v, false, true);
    try {
      const shape = prism.Shape();
      // The null `Shape()` handle is itself an owned allocation — free it before
      // the throw (cf. extrude above). On success the Solid takes ownership.
      if (shape.IsNull()) {
        shape.delete();
        throw new Error("extrudeToFace: sweeping the target face produced an empty trim tool");
      }
      return new Solid(oc, shape);
    } finally {
      prism.delete();
    }
  } finally {
    v.delete();
  }
}

/** A large rectangular face on the plane (point, normal) — the planar trim
 * tool's cross-section (caller owns the result). */
function bigPlaneFace(oc: Occt, point: Vec3, normal: Vec3, halfSize: number): TopoDS_Face {
  const p = new oc.gp_Pnt_3(point[0], point[1], point[2]);
  const d = new oc.gp_Dir_4(normal[0], normal[1], normal[2]);
  const pln = new oc.gp_Pln_3(p, d);
  const maker = new oc.BRepBuilderAPI_MakeFace_9(pln, -halfSize, halfSize, -halfSize, halfSize);
  try {
    if (!maker.IsDone()) {
      throw new Error("extrudeToFace: failed to build the planar trim face");
    }
    return maker.Face();
  } finally {
    maker.delete();
    pln.delete();
    d.delete();
    p.delete();
  }
}

/** Number of TopAbs_SOLID lumps in a shape. */
function countSolids(oc: Occt, shape: TopoDS_Shape): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
  let n = 0;
  for (; exp.More(); exp.Next()) n++;
  exp.delete();
  return n;
}

/**
 * Extrude a sketch profile from its plane "up to" the picked face of `base` —
 * a TRUE up-to-face termination: the profile is overshot past the target and
 * boolean-trimmed, so the pad's top lies exactly ON the face's surface (the
 * old behavior padded a flat top to the face centroid's projected depth,
 * exact only for planar targets perpendicular to the extrude direction).
 *
 * - PLANAR target: the trim is against the face's (extended) plane, so a
 *   profile that straddles the face's boundary still terminates on the same
 *   plane (FR-29's join-up-to-face). A perpendicular planar target reduces to
 *   the classic flat-topped pad; an angled one yields an exact wedge top.
 * - CURVED target: the trim is against the face itself (the face swept along
 *   the extrude direction), so the top conforms exactly to the curved surface.
 *   The face must cover the whole profile along the extrude direction —
 *   coverage is cross-checked by comparing the material kept BEHIND the face
 *   against the material removed BEYOND it (extending a curved surface past
 *   its boundary is not supported by the trimmed kernel build).
 *
 * Fails loudly — never fabricates geometry — when the face cannot terminate
 * the extrude: the face does not resolve, lies on the sketch plane, is
 * parallel to the extrude direction, sits behind the sketch plane, or (curved)
 * does not cover the whole profile. The result must be exactly one solid with
 * positive volume. Returns the PAD; the caller fuses it.
 */
export function extrudeToFace(
  oc: Occt,
  sketch: Sketch,
  base: Solid,
  toFace: FaceRef,
  opts?: ExtrudeToFaceOptions,
): Solid {
  const dir = normalize(opts?.direction ?? sketch.plane.normal);
  const face = resolveFaceRef(oc, base, toFace);
  if (!face) throw new Error("extrudeToFace: the target face did not resolve on the body");

  // `face` is a WASM-heap allocation and must stay alive until the trim tools
  // are derived from it — free it on EVERY exit via try/finally.
  try {
    // The face's area centroid picks WHICH side of the sketch plane to pad
    // toward (and rejects a target lying on the plane itself). The GProp props
    // are freed on every exit, incl. a throw from SurfaceProperties/CentreOfMass.
    const props = new oc.GProp_GProps_1();
    let centroid: Vec3;
    try {
      oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
      const com = props.CentreOfMass();
      centroid = [com.X(), com.Y(), com.Z()];
      com.delete();
    } finally {
      props.delete();
    }

    const signed = dot(sub(centroid, sketch.plane.origin), dir);
    if (Math.abs(signed) < 1e-9) {
      throw new Error("extrudeToFace: the target face lies on the sketch plane");
    }
    const effDir = signed >= 0 ? dir : scale(dir, -1);

    // Mesh-derived outward normal + planarity classification. The body was
    // meshed by resolveFaceRef, so the triangulation is present; for a planar
    // face the averaged mesh normal IS the exact plane normal.
    const n = faceNormal(oc, face);
    const planar = maxPlaneDeviation(oc, face, centroid, n) <= PLANAR_TOL;

    // The base's bbox diagonal is the safety margin against tolerance-grazing
    // in both trim strategies.
    const { min, max } = base.boundingBox();
    const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

    if (planar) {
      // ---- Planar target: trim against the face's (extended) plane. ----
      const align = dot(n, effDir);
      if (Math.abs(align) < 1e-6) {
        throw new Error(
          "extrudeToFace: the target face cannot terminate the extrude — its plane is parallel to the extrude direction",
        );
      }

      // Plane-hit distances from the profile's tight bbox corners (all on the
      // sketch plane): the overshoot must clear the plane over the WHOLE
      // profile — an angled plane is farther from some corners than from the
      // face centroid.
      const profFace = sketch.toFace(oc);
      let pMin: Vec3;
      let pMax: Vec3;
      try {
        const box = new oc.Bnd_Box_1();
        try {
          oc.BRepBndLib.Add(profFace, box, true);
          const lo = box.CornerMin();
          const hi = box.CornerMax();
          pMin = [lo.X(), lo.Y(), lo.Z()];
          pMax = [hi.X(), hi.Y(), hi.Z()];
          lo.delete();
          hi.delete();
        } finally {
          box.delete();
        }
      } finally {
        profFace.delete();
      }

      let tMax = -Infinity;
      let tMin = Infinity;
      let reach = 0;
      for (const p of bboxCorners(pMin, pMax)) {
        const t = dot(sub(centroid, p), n) / align;
        if (t > tMax) tMax = t;
        if (t < tMin) tMin = t;
        const r = Math.hypot(p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]);
        if (r > reach) reach = r;
      }
      if (!(tMax > 0)) {
        throw new Error(
          "extrudeToFace: the target face cannot terminate the extrude — its plane lies behind the sketch plane across the whole profile",
        );
      }

      const pDiag = Math.hypot(pMax[0] - pMin[0], pMax[1] - pMin[1], pMax[2] - pMin[2]);
      const margin = diag + pDiag;
      const overshoot = tMax + margin;
      // The slab must laterally cover the whole pad from anywhere on the plane
      // and reach past the pad's top.
      const halfSize = reach + overshoot + margin;
      const slabLength = overshoot + Math.abs(tMin) + Math.abs(tMax) + margin;

      const pad = extrude(oc, sketch, overshoot, { direction: effDir });
      // Every intermediate Solid is freed on EVERY exit; `trimmed` is nulled
      // once ownership passes to the caller.
      let slab: Solid | null = null;
      let trimmed: Solid | null = null;
      try {
        const slabFace = bigPlaneFace(oc, centroid, n, halfSize);
        try {
          slab = facePrism(oc, slabFace, scale(effDir, slabLength));
        } finally {
          slabFace.delete();
        }
        const r = subtract(oc, pad, slab);
        if (!r.ok) {
          throw new Error(
            `extrudeToFace: trimming the pad against the target face's plane failed — ${r.error}`,
          );
        }
        trimmed = r.solid;
        if (!(trimmed.volume() > 0)) {
          throw new Error(
            "extrudeToFace: the target face cannot terminate the extrude — no material lies between the sketch plane and its plane along the extrude direction",
          );
        }
        const lumps = countSolids(oc, trimmed.shape);
        if (lumps !== 1) {
          throw new Error(
            `extrudeToFace: trimming against the target face produced ${lumps} solids where exactly 1 was expected`,
          );
        }
        const out = trimmed;
        trimmed = null; // ownership passes to the caller — skip the finally delete
        return out;
      } finally {
        pad.delete();
        slab?.delete();
        trimmed?.delete();
      }
    }

    // ---- Curved target: trim against the face itself, swept into tools. ----
    // Size the overshoot and the trim tools from the base's bounding box: the
    // pad must pass every point of the target face, and each swept tool must
    // span from beyond the overshoot top back past the sketch plane.
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const p of bboxCorners(min, max)) {
      const d = dot(sub(p, sketch.plane.origin), effDir);
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
    const overshoot = dMax + diag;
    const toolLength = dMax + Math.abs(dMin) + 2 * diag;

    const pad = extrude(oc, sketch, overshoot, { direction: effDir });
    // Every intermediate Solid is freed on EVERY exit (incl. a throw from a
    // boolean or a failed validation); `trimmed` is nulled once ownership
    // passes to the caller so the success path frees everything else only.
    let behindTool: Solid | null = null;
    let beyondTool: Solid | null = null;
    let trimmed: Solid | null = null;
    let witness: Solid | null = null;
    try {
      behindTool = facePrism(oc, face, scale(effDir, -toolLength));
      beyondTool = facePrism(oc, face, scale(effDir, toolLength));

      // The true pad: overshoot ∩ (face swept BACK to the sketch plane) — its
      // top is the target face's own surface, its bottom the sketch plane.
      const ri = intersect(oc, pad, behindTool);
      if (!ri.ok) {
        throw new Error(
          `extrudeToFace: trimming the pad against the target face failed — ${ri.error}`,
        );
      }
      trimmed = ri.solid;
      // The coverage witness: overshoot − (face swept FORWARD past the top).
      // Where the face covers the profile this equals `trimmed`; any profile
      // column the face misses survives to the overshoot top instead.
      const rw = subtract(oc, pad, beyondTool);
      if (!rw.ok) {
        throw new Error(
          `extrudeToFace: trimming the pad against the target face failed — ${rw.error}`,
        );
      }
      witness = rw.solid;

      const vTrim = trimmed.volume();
      const vWitness = witness.volume();
      if (!(vTrim > 0)) {
        throw new Error(
          "extrudeToFace: the target face cannot terminate the extrude — no material lies between the sketch plane and the face along the extrude direction",
        );
      }
      if (Math.abs(vWitness - vTrim) > 1e-6 * Math.max(vWitness, vTrim)) {
        throw new Error(
          "extrudeToFace: the target face cannot terminate the extrude — it does not cover the whole profile along the extrude direction (a curved target cannot be extended past its boundary)",
        );
      }
      // A well-terminated pad is a single lump; a disconnected result means the
      // face crosses the sketch plane inside the profile (or worse) — fail
      // loudly rather than return fragmented geometry as a success.
      const lumps = countSolids(oc, trimmed.shape);
      if (lumps !== 1) {
        throw new Error(
          `extrudeToFace: trimming against the target face produced ${lumps} solids where exactly 1 was expected`,
        );
      }

      const out = trimmed;
      trimmed = null; // ownership passes to the caller — skip the finally delete
      return out;
    } finally {
      pad.delete();
      behindTool?.delete();
      beyondTool?.delete();
      witness?.delete();
      trimmed?.delete();
    }
  } finally {
    face.delete();
  }
}
