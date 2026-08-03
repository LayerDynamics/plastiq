// Feature actions on solids.

export {
  type BooleanResult,
  type OwnedShapeHistory,
  type ShapeHistory,
  releaseBooleanHistory,
  union,
  unionAll,
  subtract,
  intersect,
  cut,
} from "./boolean.js";
export { translate, rotate, mirror, scale, transformRigid } from "./transform.js";
export {
  type ExtrudeOptions,
  type ExtrudeToFaceOptions,
  type NativePrismOptions,
  type NativePrismResult,
  extrude,
  extrudeToFace,
  nativePrism,
  linearForm,
} from "./extrude.js";
export { revolve } from "./revolve.js";
export {
  type DraftOptions,
  type ShellOptions,
  type FilletOptions,
  type FilletLawLinear,
  type ChamferOptions,
  type DressupResult,
  fillet,
  filletWithHistory,
  filletLaw,
  chamfer,
  chamferWithHistory,
  shell,
  shellWithHistory,
  draft,
  draftWithHistory,
} from "./dressup.js";
export {
  type LoftOptions,
  type SweepOptions,
  type SweepTransition,
  loft,
  sweep,
  sweepAlongWire,
} from "./loft.js";
export {
  type PathPatternOptions,
  linearPattern,
  circularPattern,
  patternAlongPath,
} from "./pattern.js";
export { type HoleKind, type HoleSpec, hole } from "./hole.js";
export { type ThickenOptions, thicken } from "./thicken.js";
export { type HelixHandedness, type HelixSpec, helix } from "./helix.js";
export {
  type SurfaceFromPointsOptions,
  type PatchOptions,
  surfaceArea,
  surfaceLoft,
  surfaceSweep,
  surfaceSweepAlongWire,
  surfaceRevolve,
  surfaceFromPoints,
  offsetSurface,
  patch,
  trimSurface,
} from "./surface.js";
// sew / solidify owned by heal.ts (import-time repair + surface-pillar closure).
export {
  type HealOptions,
  type FreeEdgeReport,
  type SewResult,
  heal,
  sew,
  solidify,
  analyzeFreeBounds,
} from "./heal.js";
export { type SplitTool, split, sectionCurves } from "./split.js";
export {
  type PlaneSegment2,
  type ProjectToPlaneOptions,
  worldPolylinesToPlaneSegments,
  sectionCurvesToPlaneSegments,
} from "./projectSketch.js";
