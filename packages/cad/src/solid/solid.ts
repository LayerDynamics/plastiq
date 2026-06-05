// The Solid handle: a thin owned wrapper around an OCCT TopoDS_Shape.
//
// OCCT objects live in the WASM heap and must be explicitly freed. A Solid owns
// exactly one shape; callers that create a Solid are responsible for calling
// `.delete()` when done (the feature-rebuild loop does this between steps). The
// wrapper also keeps the engine handle so kernel functions can operate on it.

import type { Occt } from "../oc/init.js";
import type { TopoDS_Shape } from "opencascade.js";

export class Solid {
  constructor(
    readonly oc: Occt,
    /** The owned OCCT B-rep shape. */
    readonly shape: TopoDS_Shape,
  ) {}

  /** Free the underlying OCCT shape. Idempotent-safe: only the shape is freed. */
  delete(): void {
    this.shape.delete();
  }

  /** A deep copy of this solid as a new owned Solid (callers must delete it). */
  copy(): Solid {
    const copier = new this.oc.BRepBuilderAPI_Copy_2(this.shape, true, false);
    const dup = copier.Shape();
    copier.delete();
    return new Solid(this.oc, dup);
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
