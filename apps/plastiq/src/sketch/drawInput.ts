// Type-exact-dimensions-while-drawing (Fusion-style precise input). Pure model for
// the inline value box the sketcher shows during a drawing gesture: which fields the
// NEXT click exposes, their live values from the cursor, how a typed value resolves
// back to the world point clickAt receives, and which DRIVING dimensions to create so
// a typed value becomes parametric.
//
// Field policy (honest about what's parametric):
//   • line → length (mm) + angle (°) → distance + lineAngle driving dims
//   • rectangle / rectCenter → width + height (mm) → hDistance + vDistance driving dims
//   • circle → radius (mm) → radius driving dim
//   • every first click, and every click of the remaining tools (circle3, arc3,
//     arcCenter, polygon, slot, spline, point) → absolute X/Y (mm): the point is
//     PLACED exactly at the typed coordinate (precise, but no auto-dimension — those
//     shapes have no single natural driving dimension).
//
// Pure functions over plain numbers/ids, so they unit-test in Node.

import type { SketchTool } from "./sketchStore.js";
import type { SketchConstraint } from "./model.js";

export type FieldUnit = "mm" | "deg";
export interface DrawField {
  key: "x" | "y" | "length" | "angle" | "width" | "height" | "radius";
  label: string;
  unit: FieldUnit;
}
export interface Vec2 {
  u: number;
  v: number;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.u - a.u, b.v - a.v);
const ang = (a: Vec2, b: Vec2): number => Math.atan2(b.v - a.v, b.u - a.u);
const sign = (n: number): number => (n < 0 ? -1 : 1);

const XY: DrawField[] = [
  { key: "x", label: "X", unit: "mm" },
  { key: "y", label: "Y", unit: "mm" },
];
const LEN_ANG: DrawField[] = [
  { key: "length", label: "L", unit: "mm" },
  { key: "angle", label: "∠", unit: "deg" },
];
const WH: DrawField[] = [
  { key: "width", label: "W", unit: "mm" },
  { key: "height", label: "H", unit: "mm" },
];
const RAD: DrawField[] = [{ key: "radius", label: "R", unit: "mm" }];

/**
 * The input fields for the NEXT click of `tool`, given `pendingCount` points already
 * placed this gesture. The first click of any tool places its anchor by precise X/Y;
 * the shape-defining click then exposes the tool's natural fields (or X/Y).
 */
export function drawFields(tool: SketchTool, pendingCount: number): DrawField[] {
  if (tool === "select") return [];
  if (pendingCount === 0) return XY; // place the anchor precisely
  switch (tool) {
    case "line":
      return LEN_ANG;
    case "rectangle":
    case "rectCenter":
      return WH;
    case "circle":
      return RAD;
    default:
      return XY; // circle3 / arc3 / arcCenter / polygon / slot / spline / point
  }
}

/** Live SI/radian value per field for the current cursor (parallel to drawFields). */
export function liveValues(
  tool: SketchTool,
  pendingCount: number,
  anchors: Vec2[],
  cursor: Vec2,
): number[] {
  const fields = drawFields(tool, pendingCount);
  const a = anchors[0];
  return fields.map((f) => {
    switch (f.key) {
      case "x":
        return cursor.u;
      case "y":
        return cursor.v;
      case "length":
        return a ? dist(a, cursor) : 0;
      case "angle":
        return a ? ang(a, cursor) : 0;
      case "width":
        return a ? (tool === "rectCenter" ? 2 : 1) * Math.abs(cursor.u - a.u) : 0;
      case "height":
        return a ? (tool === "rectCenter" ? 2 : 1) * Math.abs(cursor.v - a.v) : 0;
      case "radius":
        return a ? dist(a, cursor) : 0;
    }
  });
}

/**
 * Resolve the world point clickAt should receive. `values[i]` is the typed SI/radian
 * value for field i, or null to use the live (cursor-derived) value. The cursor sets
 * sign/direction for the locked magnitude fields (width/height/radius keep the side
 * the cursor is on; length/angle keep the cursor's angle when only one is typed).
 */
export function resolveCursor(
  tool: SketchTool,
  pendingCount: number,
  anchors: Vec2[],
  cursor: Vec2,
  values: (number | null)[],
): Vec2 {
  const fields = drawFields(tool, pendingCount);
  const live = liveValues(tool, pendingCount, anchors, cursor);
  const val = (i: number): number => values[i] ?? live[i]!;
  const a = anchors[0];
  if (fields[0]?.key === "x") return { u: val(0), v: val(1) };
  if (fields[0]?.key === "length") {
    const L = val(0);
    const A = val(1);
    return { u: a!.u + L * Math.cos(A), v: a!.v + L * Math.sin(A) };
  }
  if (fields[0]?.key === "width") {
    const half = tool === "rectCenter" ? 0.5 : 1;
    const w = val(0) * half;
    const h = val(1) * half;
    return { u: a!.u + sign(cursor.u - a!.u) * w, v: a!.v + sign(cursor.v - a!.v) * h };
  }
  // radius
  const r = val(0);
  const dir = a ? ang(a, cursor) : 0;
  return { u: a!.u + r * Math.cos(dir), v: a!.v + r * Math.sin(dir) };
}

/** Ids of the geometry a clickAt call produced, plus the gesture's anchor points. */
export interface CommitContext {
  tool: SketchTool;
  fields: DrawField[];
  /** Typed SI/radian value per field, or null when the field was left live. */
  values: (number | null)[];
  /** Point ids that existed before this click (e.g. the line start / rect corner1). */
  anchorPointIds: string[];
  /** Point + entity ids this click created, in creation (append) order. */
  createdPointIds: string[];
  createdEntityIds: string[];
  /** Fresh constraint-id factory. */
  mkId: () => string;
}

/**
 * The driving dimensions to add for a just-committed click, locking each TYPED field
 * to its value so the sketch stays parametric. Returns [] for live (untyped) fields
 * and for the precise-X/Y tools (placement only — no natural dimension).
 */
export function drawDims(ctx: CommitContext): SketchConstraint[] {
  const { tool, fields, values, anchorPointIds, createdPointIds, createdEntityIds, mkId } = ctx;
  const locked = (key: DrawField["key"]): number | null => {
    const i = fields.findIndex((f) => f.key === key);
    return i >= 0 ? (values[i] ?? null) : null;
  };
  const out: SketchConstraint[] = [];

  if (tool === "line") {
    const start = anchorPointIds[0];
    const end = createdPointIds[0];
    const lineId = createdEntityIds[0];
    const len = locked("length");
    const angle = locked("angle");
    if (start && end && len != null) out.push({ id: mkId(), kind: "distance", a: start, b: end, value: len });
    if (lineId && angle != null) out.push({ id: mkId(), kind: "lineAngle", line: lineId, value: angle });
    return out;
  }

  if (tool === "rectangle" || tool === "rectCenter") {
    // Both build 4 corner points; width is the first horizontal edge, height the next
    // vertical edge. rectangle reuses the anchor as corner A; rectCenter drops the
    // centre and makes 4 fresh corners.
    const corners = tool === "rectangle" ? [anchorPointIds[0], ...createdPointIds] : createdPointIds;
    const [a, b, c] = corners;
    const w = locked("width");
    const h = locked("height");
    if (a && b && w != null) out.push({ id: mkId(), kind: "hDistance", a, b, value: w });
    if (b && c && h != null) out.push({ id: mkId(), kind: "vDistance", a: b, b: c, value: h });
    return out;
  }

  if (tool === "circle") {
    const circleId = createdEntityIds[0];
    const r = locked("radius");
    if (circleId && r != null) out.push({ id: mkId(), kind: "radius", circle: circleId, value: r });
    return out;
  }

  return out; // precise-X/Y tools: placed exactly, no auto-dimension
}
