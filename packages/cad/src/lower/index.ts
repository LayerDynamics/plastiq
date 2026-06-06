// Assembly → SimManifest lowering.

export {
  type ManifestBody,
  type ManifestConstraint,
  type HullCollider,
  type SimManifest,
  isSimManifest,
} from "./manifest.js";
export { type ConvexHull, convexHull } from "./hull.js";
export { type MassProperties, massProperties } from "./massprops.js";
export {
  type Placement,
  type MaterialLibrary,
  IDENTITY_PLACEMENT,
  Body,
  makeBody,
  Component,
  defaultLibrary,
} from "./component.js";
export {
  type Joint,
  type JointBinding,
  makeJoint,
  isLowerable,
  lowerJoints,
} from "./joints.js";
export { type ExportOptions, exportForSim } from "./export.js";
export {
  type DecomposeOptions,
  initDecomposer,
  decomposerReady,
  collidersFor,
  meshVolume,
} from "./decompose.js";
