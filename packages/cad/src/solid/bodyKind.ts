// Body-kind discriminator for B-rep shapes (§11 / §17).
//
// CadDocument bodies are typed as solid | shell | face | freeform | mesh | voxel.
// This module classifies an OCCT-backed {@link Solid} (which wraps any
// TopoDS_Shape) into the B-rep subset — freeform/mesh/voxel are set by those
// lanes, never by ShapeType.

import type { TopAbs_ShapeEnum, TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { shapeEnums } from "../mesh/normals.js";
import type { Solid } from "./solid.js";

/**
 * First-class body kinds carried through TaggedMesh → TransferMesh → scene
 * (FablesFindings §11 / §17). Optional on the wire for back-compat.
 */
export type BodyKind = "solid" | "shell" | "face" | "freeform" | "mesh" | "voxel";

type FullShapeEnums = ReturnType<typeof shapeEnums> & {
  TopAbs_COMPOUND: TopAbs_ShapeEnum;
  TopAbs_COMPSOLID: TopAbs_ShapeEnum;
};

function fullEnums(oc: Occt): FullShapeEnums {
  return oc.TopAbs_ShapeEnum as unknown as FullShapeEnums;
}

function hasSubshape(oc: Occt, shape: TopoDS_Shape, kind: TopAbs_ShapeEnum): boolean {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(shape, kind, S.TopAbs_SHAPE);
  try {
    return exp.More();
  } finally {
    exp.delete();
  }
}

/**
 * Classify a rebuilt shape into a document body kind.
 *
 * - TopAbs_SOLID / COMPSOLID → `"solid"`
 * - TopAbs_SHELL → `"shell"`
 * - TopAbs_FACE → `"face"`
 * - COMPOUND → most solid-like content (solid > shell > face); multi-body
 *   compounds of solids (§2.4) report `"solid"`.
 * - Anything else falls back to `"solid"` so legacy closed parts keep working.
 *
 * Does not produce freeform/mesh/voxel — those come from non-OCCT lanes.
 */
export function bodyKindOf(oc: Occt, solid: Solid): BodyKind {
  const S = fullEnums(oc);
  const t = solid.shape.ShapeType();
  if (t === S.TopAbs_SOLID || t === S.TopAbs_COMPSOLID) return "solid";
  if (t === S.TopAbs_SHELL) return "shell";
  if (t === S.TopAbs_FACE) return "face";
  // Compound / residual: prefer closed solids over open sheets.
  if (hasSubshape(oc, solid.shape, S.TopAbs_SOLID)) return "solid";
  if (hasSubshape(oc, solid.shape, S.TopAbs_SHELL)) return "shell";
  if (hasSubshape(oc, solid.shape, S.TopAbs_FACE)) return "face";
  return "solid";
}

/**
 * True when the shape can carry free (naked) edges — open shells and lone faces.
 * Closed solids never do; multi-body solid compounds don't either.
 */
export function shapeMayHaveFreeEdges(oc: Occt, solid: Solid): boolean {
  const kind = bodyKindOf(oc, solid);
  return kind === "shell" || kind === "face";
}
