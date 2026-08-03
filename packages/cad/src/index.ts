// @plastiq/cad — parametric CAD modeling kernel.
//
// An independent kernel built directly on opencascade.js (OCCT → WebAssembly)
// for B-rep geometry, @salusoft89/planegcs (FreeCAD PlaneGCS, wasm) for the 2D
// sketch constraint solver, and a first-party 3D assembly-mate solver. It owns
// geometry types, feature actions, sketch + mate solvers, tagged tessellation,
// interchange I/O, and assembly→physics lowering.
//
// The public API is built up bottom-first across milestones R2–R6; each
// submodule is re-exported here only once it is implemented for real (no stubs).
// See docs/plans/2026-06-05-plastiq-independent-app.md for the full contract.

/** Kernel version, surfaced for tooling/diagnostics. */
export const CAD_KERNEL_VERSION = "0.1.0" as const;

// R2 — engine, units, geometry core.
export { initOcct, type Occt } from "./oc/init.js";
export { describeOcctError, isRawOcctFailure } from "./oc/error.js";
export { mm, cm, m, inch, deg, rad, toMm, toDeg } from "./unit/index.js";
export { Solid, makeCompound, bodiesOf, type ShapeDistance } from "./solid/solid.js";
export { type BodyKind, bodyKindOf, shapeMayHaveFreeEdges } from "./solid/bodyKind.js";
export {
  makeBox,
  makeBoxAt,
  makeCylinder,
  makeSphere,
  makeCone,
  makeTorus,
  type AxisPlacement,
} from "./solid/primitives.js";
export {
  type DatumPlane,
  planeXY,
  planeXZ,
  planeYZ,
  offsetPlane,
  planeYAxis,
  planePointToWorld,
  worldPointToPlane,
} from "./env/plane.js";

// R3 — tagged tessellation, persistent EdgeRef/FaceRef, interchange I/O.
export {
  type FaceRef,
  type EdgeRef,
  type VertexRef,
  type FaceGroup,
  type TaggedEdge,
  type VertexPoint,
  type TaggedMesh,
  type TessellateOptions,
  type SurfaceSignature,
} from "./mesh/tagged.js";
export { tessellateTagged } from "./mesh/tessellate.js";
export {
  resolveFaceRef,
  resolveEdgeRef,
  resolveVertexRef,
  resolveEdgeDirection,
  resolveEdgeAxis,
} from "./mesh/resolve.js";
// §13.1 derivation-based naming — BRepTools_History is CALLABLE in this wasm
// (proven by oc/history.pin.test.ts); faceIdRemap walks it to an old→new faceId map.
export {
  faceIdRemap,
  FACE_REMOVED,
  ownedBooleanHistory,
  ownedMakerHistory,
  type ShapeHistory,
  type OwnedShapeHistory,
} from "./mesh/remap.js";
export {
  resolveSelector,
  isSelector,
  type Selector,
  type SelectorResult,
} from "./select/predicates.js";
// surfacesMatch is pure data (SurfaceSignature comparison, no OCCT) — exported so
// the main thread can remap picks with the EXACT matching the kernel resolver uses (R4).
export { surfacesMatch } from "./mesh/surface.js";
export { faceDatumPlane } from "./mesh/faceFrame.js";
export {
  exportStep,
  exportStepAssembly,
  importStep,
  exportIges,
  exportIgesAssembly,
  importIges,
  exportGltf,
  exportGltfAssembly,
} from "./io/index.js";

// R4 — sketch profiles + feature operations.
export { Sketch } from "./sketch/sketch.js";
export {
  type BooleanResult,
  type ExtrudeOptions,
  releaseBooleanHistory,
  union,
  unionAll,
  subtract,
  intersect,
  cut,
  translate,
  rotate,
  mirror,
  scale,
  transformRigid,
  extrude,
  nativePrism,
  linearForm,
  revolve,
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
  type ExtrudeToFaceOptions,
  type NativePrismOptions,
  type NativePrismResult,
  extrudeToFace,
  type LoftOptions,
  type SweepOptions,
  type SweepTransition,
  loft,
  sweep,
  sweepAlongWire,
  type PathPatternOptions,
  linearPattern,
  circularPattern,
  patternAlongPath,
  type HoleKind,
  type HoleSpec,
  hole,
  type ThickenOptions,
  thicken,
  type HelixHandedness,
  type HelixSpec,
  helix,
  type SplitTool,
  split,
  sectionCurves,
  type PlaneSegment2,
  type ProjectToPlaneOptions,
  worldPolylinesToPlaneSegments,
  sectionCurvesToPlaneSegments,
  type HealOptions,
  type FreeEdgeReport,
  type SewResult,
  heal,
  sew,
  solidify,
  analyzeFreeBounds,
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
} from "./action/index.js";
export {
  type SpinePath,
  type SpinePolyline,
  type SpineSegmented,
  type SpineSegment,
  buildSpineWire,
  buildWireFromEdges,
} from "./sketch/spine.js";
// Helical spines: `helix(oc, spec)` → TopoDS_Wire, then `sweepAlongWire(oc, profile, wire, opts)`
// (consumes the wire). Not a SpinePath kind — see action/helix.ts route note.

// R5 — sketch constraint solver (planegcs) + 3D assembly mate solver.
export {
  type SolverPoint,
  type SolverCircle,
  type SolverEllipse,
  type SolverArc,
  type Constraint,
  type SketchVerdict,
  type SolveResult,
  initSketchSolver,
  sketchSolverReady,
  solveSketch,
} from "./sketch/solver.js";
export {
  type ComponentPose,
  type MateRef,
  type Mate,
  type JointKind,
  type AssemblyVerdict,
  type MateSolveResult,
  solveMates,
} from "./assembly/solver.js";

// R6 — assembly → SimManifest lowering.
export {
  type ManifestBody,
  type ManifestConstraint,
  type HullCollider,
  type SimManifest,
  isSimManifest,
  type ConvexHull,
  convexHull,
  type MassProperties,
  massProperties,
  type Placement,
  type MaterialLibrary,
  IDENTITY_PLACEMENT,
  Body,
  makeBody,
  Component,
  defaultLibrary,
  type Joint,
  type JointBinding,
  makeJoint,
  isLowerable,
  lowerJoints,
  type ExportOptions,
  exportForSim,
  type DecomposeOptions,
  initDecomposer,
  decomposerReady,
  collidersFor,
  meshVolume,
} from "./lower/index.js";

// Freeform (NURBS) pillar — pure-TS de Boor evaluator + generators + tessellator
// (§15 Lane A(a)). No OCCT in the interactive control-net loop; the B-rep commit
// path (surfaceFromPoints / Geom_BSplineSurface) consumes this model at rebuild.
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
  evaluate,
  evaluateWithNormal,
  tessellate as tessellateFreeform,
  elevateDegreeU,
  elevateDegreeV,
  insertKnotU,
  insertKnotV,
  moveControlPoint,
  planeSurface,
  cylinderSurface,
  sphereSurface,
  mirrorControlNet,
  freeformToFace,
  expandCompactKnots,
  serviceSurfaceToNurbs,
  type ServiceNurbsSurface,
  type NurbsSurface,
  type Vec3 as FreeformVec3,
  type TessellatedSurface,
  type FreeformCommitOptions,
  type TessellateOptions as FreeformTessellateOptions,
} from "./freeform/index.js";
