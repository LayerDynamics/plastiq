// Feature unit semantics — the single source of truth for which numeric feature
// params are lengths (mm <-> m) vs angles (deg <-> rad), plus the list of feature
// types. Shared by the AI authoring converter (ai/tools/schema.ts) and the
// properties panel's mm/deg display (app/PropertiesPanel.tsx) so the two can never
// drift. Classification mirrors apps/plastiq/src/worker/rebuild.ts exactly.

import { mm, deg, toMm, toDeg } from "@plastiq/cad";

/** Every feature type the rebuild evaluator supports (rebuild.ts switch). */
export const FEATURE_TYPES = [
  "box",
  "sketch",
  "extrude",
  "revolve",
  "loft",
  "sweep",
  "cut",
  "fillet",
  "chamfer",
  "shell",
  "draft",
  "transform",
  "mirror",
  "linearPattern",
  "circularPattern",
  "boolean",
  "importStep",
  "placement",
] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

/** Numeric params that are LENGTHS (mm <-> m), per feature type. */
export const LENGTH_PARAMS: Record<string, readonly string[]> = {
  box: ["dx", "dy", "dz"],
  extrude: ["height", "back"],
  cut: ["depth", "back"],
  fillet: ["radius"],
  chamfer: ["distance"],
  shell: ["thickness"],
  // Revolve axis origin (ox,oy,oz) is a length so AI authoring in mm converts correctly.
  revolve: ["ox", "oy", "oz"],
  transform: ["tx", "ty", "tz"],
  mirror: ["ox", "oy", "oz"],
  linearPattern: ["spacing"],
  circularPattern: ["ox", "oy", "oz"],
  boolean: ["dx", "dy", "dz", "tx", "ty", "tz"],
  placement: ["tx", "ty", "tz"],
};

/** Numeric params that are ANGLES (deg <-> rad), per feature type. */
export const ANGLE_PARAMS: Record<string, readonly string[]> = {
  revolve: ["angle"],
  draft: ["angle"],
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
