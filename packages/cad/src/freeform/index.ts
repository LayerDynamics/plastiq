// @plastiq/cad — freeform (NURBS) modeling pillar, Lane A(a).
//
// Pure-TS de Boor NURBS surface evaluator + tessellator + editing ops, with a
// self-contained surface data model. No OCCT and no @plastiq/nurbs dependency —
// this runs in the interactive control-net editing loop (60 fps re-tessellation
// on control-point drags) per FablesFindings.md §15 Lane A(a). The B-rep commit
// path (freeform → Geom_BSplineSurface → MakeFace/sew/solidify, §15(b)) lives
// elsewhere and consumes this model.

export {
  cloneSurface,
  domain,
  findSpan,
  findSpanMult,
  isRational,
  KNOT_EPS,
  makeNurbsSurface,
  numU,
  numV,
  toHomogeneous,
  validateSurface,
} from "./nurbsSurface.js";
export type { NurbsSurface, Vec3, Vec4 } from "./nurbsSurface.js";

export { evaluate, evaluateWithNormal } from "./deBoor.js";

export { tessellate } from "./tessellate.js";
export type { TessellateOptions, TessellatedSurface } from "./tessellate.js";

export {
  elevateDegreeU,
  elevateDegreeV,
  insertKnotU,
  insertKnotV,
  moveControlPoint,
} from "./ops.js";

export {
  planeSurface,
  cylinderSurface,
  sphereSurface,
  mirrorControlNet,
} from "./generators.js";

export {
  expandCompactKnots,
  serviceSurfaceToNurbs,
  type ServiceNurbsSurface,
} from "./fromService.js";

export { freeformToFace, type FreeformCommitOptions } from "./commit.js";
