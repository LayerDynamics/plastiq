// The Solid handle: a thin owned wrapper around an OCCT TopoDS_Shape.
//
// OCCT objects live in the WASM heap and must be explicitly freed. A Solid owns
// exactly one shape; callers that create a Solid are responsible for calling
// `.delete()` when done (the feature-rebuild loop does this between steps). The
// wrapper also keeps the engine handle so kernel functions can operate on it.

import type { Occt } from "../oc/init.js";
import type { TopoDS_Shape } from "opencascade.js";

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

  /** A deep copy of this solid as a new owned Solid (callers must delete it). */
  copy(): Solid {
    const copier = new this.oc.BRepBuilderAPI_Copy_2(this.shape, true, false);
    const dup = copier.Shape();
    copier.delete();
    return new Solid(this.oc, dup);
  }

  /** Whether the B-rep shape passes OCCT's validity checks. */
  isValid(): boolean {
    const analyzer = new this.oc.BRepCheck_Analyzer(this.shape, true, false);
    const valid = analyzer.IsValid_2();
    analyzer.delete();
    return valid;
  }

  /** Volume in cubic metres (closed-shape volume properties). */
  volume(): number {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(this.shape, props, false, false, false);
    const v = props.Mass();
    props.delete();
    return v;
  }

  /** Centre of mass in SI metres. */
  centreOfMass(): [number, number, number] {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(this.shape, props, false, false, false);
    const c = props.CentreOfMass();
    const out: [number, number, number] = [c.X(), c.Y(), c.Z()];
    c.delete();
    props.delete();
    return out;
  }

  /** Axis-aligned bounding box corners [min, max] in SI metres. */
  boundingBox(): { min: [number, number, number]; max: [number, number, number] } {
    const box = new this.oc.Bnd_Box_1();
    this.oc.BRepBndLib.Add(this.shape, box, true);
    const lo = box.CornerMin();
    const hi = box.CornerMax();
    const min: [number, number, number] = [lo.X(), lo.Y(), lo.Z()];
    const max: [number, number, number] = [hi.X(), hi.Y(), hi.Z()];
    lo.delete();
    hi.delete();
    box.delete();
    return { min, max };
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
