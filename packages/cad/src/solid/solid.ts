// B-rep solid wrapper (SPEC-4 Task 0.5 / FR-1).
//
// Owns an OCCT `TopoDS_Shape` handle and exposes the topology queries +
// validity check the kernel relies on, with explicit lifetime (`delete()`).
// The shape is a ref-counted handle into OCCT's TShape, so it survives the
// deletion of the builder that produced it (the standard ocjs pattern).

import type { TopAbs_ShapeEnum, TopoDS_Shape } from "opencascade.js";
import type { Occt } from "../oc/init.js";

export class Solid {
  constructor(
    private readonly oc: Occt,
    /** The owned OCCT shape handle. */
    readonly shape: TopoDS_Shape,
  ) {}

  /** True iff OCCT considers the shape topologically/geometrically valid (NFR-1). */
  isValid(): boolean {
    // geomControls = true (full geometric checks), parallel = false (C6).
    const analyzer = new this.oc.BRepCheck_Analyzer(this.shape, true, false);
    try {
      return analyzer.IsValid_2();
    } finally {
      analyzer.delete();
    }
  }

  /** Number of unique faces. (A box → 6.) */
  countFaces(): number {
    return this.countUnique(this.oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum);
  }

  /** Number of unique edges. (A box → 12.) */
  countEdges(): number {
    return this.countUnique(this.oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
  }

  /** Number of unique vertices. (A box → 8.) */
  countVertices(): number {
    return this.countUnique(this.oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum);
  }

  // Unique count via TopExp::MapShapes (a plain TopExp_Explorer double-counts
  // edges/vertices shared between faces).
  private countUnique(kind: TopAbs_ShapeEnum): number {
    const map = new this.oc.TopTools_IndexedMapOfShape_1();
    try {
      this.oc.TopExp.MapShapes_1(this.shape, kind, map);
      return map.Extent();
    } finally {
      map.delete();
    }
  }

  /** Release the owned OCCT shape handle. */
  delete(): void {
    this.shape.delete();
  }
}
