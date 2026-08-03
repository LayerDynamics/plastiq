// Feature unit semantics — the single source of truth for which numeric feature
// params are lengths (mm <-> m) vs angles (deg <-> rad), plus the list of feature
// types. Shared by the AI authoring converter (ai/tools/schema.ts) and the
// properties panel's mm/deg display (app/PropertiesPanel.tsx) so the two can never
// drift. Classification mirrors apps/plastiq/src/worker/rebuild.ts exactly.

import { mm, deg, toMm, toDeg } from "@plastiq/cad";

/** Every feature type the rebuild evaluator supports (rebuild.ts switch). */
export const FEATURE_TYPES = [
  "box",
  "cylinder",
  "sphere",
  "cone",
  "torus",
  "sketch",
  "extrude",
  "rib",
  "revolve",
  "loft",
  "sweep",
  "cut",
  "fillet",
  "chamfer",
  "shell",
  "draft",
  "hole",
  "thicken",
  // §14 surface pillar — open sheet bodies + closure ops (kernel in action/surface.ts + heal.ts).
  "surfaceLoft",
  "surfaceSweep",
  "surfaceRevolve",
  "surfaceFromPoints",
  "offsetSurface",
  "sew",
  "solidify",
  // §14 free-edge fill: MakeFilling over a closed free-edge loop.
  "patch",
  // §14 keep-one-side plane trim of the current body.
  "trim",
  "transform",
  "scale",
  "mirror",
  "linearPattern",
  "circularPattern",
  "pathPattern",
  "split",
  "section",
  "boolean",
  "importStep",
  "importIges",
  "placement",
  // Freeform NURBS surface body (§15): control-net stored as NurbsSurface JSON;
  // rebuild samples via pure-TS evaluate → surfaceFromPoints face Solid.
  "freeform",
] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

/** Numeric params that are LENGTHS (mm <-> m), per feature type. */
export const LENGTH_PARAMS: Record<string, readonly string[]> = {
  box: ["dx", "dy", "dz"],
  // Round primitives (§4.11). Their placement origin (ox,oy,oz) is a length, like
  // revolve's/mirror's, so mm authoring converts; the axis (ax,ay,az) is a unitless
  // DIRECTION and is deliberately absent from both tables (a scalar).
  cylinder: ["radius", "height", "ox", "oy", "oz"],
  sphere: ["radius", "ox", "oy", "oz"],
  cone: ["radius1", "radius2", "height", "ox", "oy", "oz"],
  torus: ["majorRadius", "minorRadius", "ox", "oy", "oz"],
  extrude: ["height", "back"],
  rib: ["length"],
  cut: ["depth", "back"],
  fillet: ["radius", "radius2"],
  chamfer: ["distance", "distance2"],
  // Transform pivot (C7) is length so Properties/AI mm conversion is correct.
  // (tx/ty/tz already listed under transform below.)
  shell: ["thickness"],
  // Hole (§13.2): every linear dimension; the kind + through-all flag + drill
  // point are on data/angles. counterbore = spotface geometry too.
  hole: ["diameter", "depth", "counterboreDiameter", "counterboreDepth", "countersinkDiameter"],
  // Thicken (§13.2/§14): wall thickness is a length; bothSides is a data flag.
  thicken: ["thickness"],
  // §14 surface ops: offset distance, sewing tolerance, revolve origin; surface
  // loft/sweep section/path lengths live in `data` (see schema convData), not params.
  offsetSurface: ["distance"],
  sew: ["tolerance"],
  surfaceFromPoints: ["tolerance"],
  surfaceRevolve: ["ox", "oy", "oz"],
  // Revolve axis origin (ox,oy,oz) is a length so AI authoring in mm converts correctly.
  revolve: ["ox", "oy", "oz"],
  transform: ["tx", "ty", "tz", "px", "py", "pz"],
  // Uniform scale (§2.5): `factor` is a unitless scalar (deliberately absent from
  // both tables); the pivot px/py/pz is a length so mm authoring converts.
  scale: ["px", "py", "pz"],
  mirror: ["ox", "oy", "oz"],
  linearPattern: ["spacing"],
  circularPattern: ["ox", "oy", "oz"],
  // pathPattern: count is unitless; the spine lives in data.path (schema convData).
  // split / section: plane origin lives in data.plane (schema convData); no length params.
  boolean: ["dx", "dy", "dz", "tx", "ty", "tz"],
  placement: ["tx", "ty", "tz"],
  // Freeform (§15): plane sizes, cylinder/sphere radius+height, placement origin.
  // resU/resV sample density is unitless (scalar). Axis ax/ay/az unitless.
  freeform: ["uSize", "vSize", "radius", "height", "ox", "oy", "oz"],
};

/** Numeric params that are ANGLES (deg <-> rad), per feature type. */
export const ANGLE_PARAMS: Record<string, readonly string[]> = {
  // Round primitives' partial sweep (a pie wedge); 360° = the full solid.
  cylinder: ["angle"],
  sphere: ["angle"],
  cone: ["angle"],
  torus: ["angle"],
  // Native on-face BRepFeat_MakeDPrism taper.
  extrude: ["draftAngle"],
  cut: ["draftAngle"],
  revolve: ["angle"],
  surfaceRevolve: ["angle"],
  draft: ["angle"],
  hole: ["countersinkAngle", "tipAngle"],
  transform: ["angle"],
  circularPattern: ["angle"],
  placement: ["rx", "ry", "rz"],
};

export type ParamUnit = "length" | "angle" | "scalar";

/** Classify a feature param as a length, an angle, or a unitless scalar. */
export function classifyParam(featureType: string, key: string): ParamUnit {
  if ((LENGTH_PARAMS[featureType] ?? []).includes(key)) return "length";
  if ((ANGLE_PARAMS[featureType] ?? []).includes(key)) return "angle";
  return "scalar";
}

/** SI value → display value (mm for lengths, degrees for angles, as-is otherwise). */
export function toDisplayValue(featureType: string, key: string, si: number): number {
  const u = classifyParam(featureType, key);
  return u === "length" ? toMm(si) : u === "angle" ? toDeg(si) : si;
}

/** Display value (mm/deg) → SI value (m/rad) for committing an edit. */
export function fromDisplayValue(featureType: string, key: string, display: number): number {
  const u = classifyParam(featureType, key);
  return u === "length" ? mm(display) : u === "angle" ? deg(display) : display;
}

/** The unit suffix to show next to a param field ("mm", "°", or ""). */
export function unitSuffix(featureType: string, key: string): string {
  const u = classifyParam(featureType, key);
  return u === "length" ? "mm" : u === "angle" ? "°" : "";
}
