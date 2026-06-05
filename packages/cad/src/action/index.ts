// Feature actions on solids.

export { type BooleanResult, union, subtract, intersect, cut } from "./boolean.js";
export { translate, rotate, mirror } from "./transform.js";
export {
  type ExtrudeOptions,
  type ExtrudeToFaceOptions,
  extrude,
  extrudeToFace,
} from "./extrude.js";
export { revolve } from "./revolve.js";
export { type DraftOptions, fillet, chamfer, shell, draft } from "./dressup.js";
export { type LoftOptions, loft, sweep } from "./loft.js";
export { linearPattern, circularPattern } from "./pattern.js";
