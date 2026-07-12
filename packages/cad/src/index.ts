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
export { mm, cm, m, inch, deg, rad, toMm, toDeg } from "./unit/index.js";
export { Solid } from "./solid/solid.js";
export { makeBox, makeBoxAt } from "./solid/primitives.js";
export {
  type DatumPlane,
  planeXY,
  planeXZ,
  planeYZ,
  offsetPlane,
  planeYAxis,
  planePointToWorld,
} from "./env/plane.js";

// R3 — tagged tessellation, persistent EdgeRef/FaceRef, interchange I/O.
export {
  type FaceRef,
  type EdgeRef,
  type FaceGroup,
  type TaggedEdge,
  type VertexPoint,
  type TaggedMesh,
  type TessellateOptions,
} from "./mesh/tagged.js";
export { tessellateTagged } from "./mesh/tessellate.js";
export { resolveFaceRef, resolveEdgeRef, resolveEdgeDirection } from "./mesh/resolve.js";
export { resolveSelector, isSelector, type Selector, type SelectorResult } from "./select/predicates.js";
export { faceDatumPlane } from "./mesh/faceFrame.js";
export { exportStep, importStep, exportIges, exportGltf } from "./io/index.js";

// R4 — sketch profiles + feature operations.
export { Sketch } from "./sketch/sketch.js";
export {
  type BooleanResult,
  type ExtrudeOptions,
  union,
  subtract,
  intersect,
  cut,
  translate,
  rotate,
  mirror,
  extrude,
  revolve,
  type DraftOptions,
  type ShellOptions,
  fillet,
  chamfer,
  shell,
  draft,
  type ExtrudeToFaceOptions,
  extrudeToFace,
  type LoftOptions,
  type SweepOptions,
  type SweepTransition,
  loft,
  sweep,
  linearPattern,
  circularPattern,
} from "./action/index.js";
export {
  type SpinePath,
  type SpinePolyline,
  type SpineSegmented,
  type SpineSegment,
  buildSpineWire,
} from "./sketch/spine.js";

// R5 — sketch constraint solver (planegcs) + 3D assembly mate solver.
export {
  type SolverPoint,
  type SolverCircle,
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
