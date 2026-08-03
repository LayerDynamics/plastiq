// The Solid handle: a thin owned wrapper around an OCCT TopoDS_Shape.
//
// OCCT objects live in the WASM heap and must be explicitly freed. A Solid owns
// exactly one shape; callers that create a Solid are responsible for calling
// `.delete()` when done (the feature-rebuild loop does this between steps). The
// wrapper also keeps the engine handle so kernel functions can operate on it.

import type { Occt } from "../oc/init.js";
import type { TopoDS_Shape } from "opencascade.js";
import { shapeEnums } from "../mesh/normals.js";

export interface ShapeDistance {
  /** Exact minimum B-rep separation in SI metres (zero for touching/intersection). */
  distance: number;
  /** Closest points on this shape and `other`, respectively, in SI metres. */
  points: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** OCCT reports one shape contained inside the other. */
  inner: boolean;
}

export class Solid {
  /** True once {@link delete} has freed the shape — guards against a double-free. */
  private disposed = false;

  constructor(
    readonly oc: Occt,
    /** The owned OCCT B-rep shape. */
    readonly shape: TopoDS_Shape,
  ) {}

  /** Free the underlying OCCT shape. Idempotent: a second call is a no-op (a bare
   * `this.shape.delete()` would double-free the wasm object and throw). */
  delete(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shape.delete();
  }

  /** A deep copy of this solid as a new owned Solid (callers must delete it).
   *
   * K6 — the copier is freed on EVERY exit: should `Shape()` raise a
   * Standard_Failure it would otherwise leak in the long-lived worker. */
  copy(): Solid {
    const copier = new this.oc.BRepBuilderAPI_Copy_2(this.shape, true, false);
    try {
      return new Solid(this.oc, copier.Shape());
    } finally {
      copier.delete();
    }
  }

  /** Whether the B-rep shape passes OCCT's validity checks. */
  isValid(): boolean {
    const analyzer = new this.oc.BRepCheck_Analyzer(this.shape, true, false);
    try {
      return analyzer.IsValid_2();
    } finally {
      analyzer.delete();
    }
  }

  /** Volume in cubic metres (closed-shape volume properties). */
  volume(): number {
    const props = new this.oc.GProp_GProps_1();
    try {
      this.oc.BRepGProp.VolumeProperties_1(this.shape, props, false, false, false);
      return props.Mass();
    } finally {
      props.delete();
    }
  }

  /** Centre of mass in SI metres. */
  centreOfMass(): [number, number, number] {
    // K6 — props and the returned gp_Pnt are freed on every exit (nested finally),
    // so a Standard_Failure from VolumeProperties/CentreOfMass leaks neither.
    const props = new this.oc.GProp_GProps_1();
    try {
      this.oc.BRepGProp.VolumeProperties_1(this.shape, props, false, false, false);
      const c = props.CentreOfMass();
      try {
        return [c.X(), c.Y(), c.Z()];
      } finally {
        c.delete();
      }
    } finally {
      props.delete();
    }
  }

  /** Axis-aligned bounding box corners [min, max] in SI metres. */
  boundingBox(): { min: [number, number, number]; max: [number, number, number] } {
    // K6 — box and both corner points are freed on every exit; nested finallys so
    // a throw between allocating `lo` and `hi` still frees whatever exists.
    const box = new this.oc.Bnd_Box_1();
    try {
      this.oc.BRepBndLib.Add(this.shape, box, true);
      const lo = box.CornerMin();
      try {
        const hi = box.CornerMax();
        try {
          const min: [number, number, number] = [lo.X(), lo.Y(), lo.Z()];
          const max: [number, number, number] = [hi.X(), hi.Y(), hi.Z()];
          return { min, max };
        } finally {
          hi.delete();
        }
      } finally {
        lo.delete();
      }
    } finally {
      box.delete();
    }
  }

  /**
   * Exact minimum distance to another B-rep shape via
   * `BRepExtrema_DistShapeShape`. Unlike tessellation/AABB approximations this
   * evaluates the underlying curves and surfaces. Both solids must belong to
   * this OCCT engine instance.
   */
  distanceTo(other: Solid): ShapeDistance {
    if (other.oc !== this.oc)
      throw new Error("distanceTo: solids belong to different OCCT engines");
    const extrema = new this.oc.BRepExtrema_DistShapeShape_1();
    const progress = new this.oc.Message_ProgressRange_1();
    try {
      extrema.LoadS1(this.shape);
      extrema.LoadS2(other.shape);
      if (!extrema.Perform(progress) || !extrema.IsDone() || extrema.NbSolution() < 1) {
        throw new Error("distanceTo: OCCT could not compute a shape distance");
      }
      const a = extrema.PointOnShape1(1);
      try {
        const b = extrema.PointOnShape2(1);
        try {
          return {
            distance: extrema.Value(),
            points: [
              [a.X(), a.Y(), a.Z()],
              [b.X(), b.Y(), b.Z()],
            ],
            inner: extrema.InnerSolution(),
          };
        } finally {
          b.delete();
        }
      } finally {
        a.delete();
      }
    } finally {
      progress.delete();
      extrema.delete();
    }
  }
}

/**
 * Assemble several solids into ONE multi-body shape (a `TopoDS_Compound`).
 *
 * This is the representation a MULTI-BODY document needs (§2.4): the bodies stay
 * separate — no boolean runs, so nothing is welded and each keeps its own faces,
 * edges and volume — while the rest of the kernel still sees a single
 * {@link Solid}. That is what makes it a drop-in for the rebuild accumulator:
 * `Solid` wraps a generic `TopoDS_Shape`, and volume/bbox/validity/tessellation/
 * booleans/dress-up/STEP export all accept a compound (measured, not assumed).
 *
 * Contrast with `unionAll`, which FUSES its inputs into one body — correct for a
 * pattern that should become a single solid, wrong for "new body".
 *
 * The inputs are NOT consumed: the compound holds its own references to their
 * underlying (refcounted) shapes, so the caller still owns and frees each input,
 * and the compound stays valid afterwards. A single input yields a compound
 * wrapping just that body, so callers get uniform ownership either way.
 */
export function makeCompound(oc: Occt, solids: readonly Solid[]): Solid {
  if (solids.length === 0) throw new Error("makeCompound: no solids to assemble");
  const builder = new oc.BRep_Builder();
  const compound = new oc.TopoDS_Compound();
  try {
    builder.MakeCompound(compound);
    for (const s of solids) builder.Add(compound, s.shape);
  } catch (e) {
    compound.delete();
    throw e;
  } finally {
    builder.delete();
  }
  return new Solid(oc, compound);
}

/**
 * The individual BODIES inside a shape, each as its own owned {@link Solid}.
 *
 * A plain solid yields one entry; a multi-body compound (§2.4 `op:"new"`) yields
 * one per body, in the kernel's own exploration order. This is what lets the
 * product report "2 bodies" and their separate volumes instead of only a summed
 * total — a multi-body document is otherwise indistinguishable from a single
 * body in every readout.
 *
 * The returned solids are INDEPENDENT handles the caller must delete; the input
 * is untouched. A shape with no TopAbs_SOLID inside (e.g. a bare shell) yields
 * an empty array rather than lying about its contents.
 */
export function bodiesOf(oc: Occt, solid: Solid): Solid[] {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
  const out: Solid[] = [];
  try {
    while (exp.More()) {
      out.push(new Solid(oc, oc.TopoDS.Solid_1(exp.Current())));
      exp.Next();
    }
  } catch (e) {
    for (const b of out) b.delete();
    throw e;
  } finally {
    exp.delete();
  }
  return out;
}
