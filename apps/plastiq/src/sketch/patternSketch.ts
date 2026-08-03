// §13.3 pattern-in-sketch — linear / circular pattern of sketch entities with
// constraint replication. Pure: SketchModel in → new entities + constraints out.

import type {
  ArcEntity,
  CircleEntity,
  EllipseEntity,
  LineEntity,
  OffsetEntity,
  SketchConstraint,
  SketchEntity,
  SketchModel,
  SketchPoint,
  SplineEntity,
} from "./model.js";

/** Linear pattern: `count` instances (including the seed) spaced along `direction`. */
export interface LinearSketchPattern {
  readonly kind: "linear";
  /** Total instances including the original seed (must be ≥ 1). */
  readonly count: number;
  /** Offset direction in plane (u,v); unitized internally. */
  readonly direction: readonly [number, number];
  /** Distance between consecutive instances (SI metres). */
  readonly spacing: number;
}

/**
 * Circular pattern: `count` instances about `center`, evenly spaced over
 * `angle` radians. When `angle` is a full turn (±2π within 1e-9), the step is
 * 2π/count (last copy does not re-stack on the seed). Otherwise the step is
 * angle/(count−1) for count>1 (or 0 for count=1) — same semantics as the solid
 * circularPattern.
 */
export interface CircularSketchPattern {
  readonly kind: "circular";
  readonly count: number;
  readonly center: readonly [number, number];
  /** Total sweep in radians (default 2π). */
  readonly angle?: number;
}

export type SketchPatternParams = LinearSketchPattern | CircularSketchPattern;

export interface PatternSketchOptions {
  /** Id factory for new points/entities/constraints. */
  readonly makeId?: (prefix: "p" | "e" | "c") => string;
  /**
   * Entity ids to pattern. Default: all non-construction entities. Construction
   * geometry is never patterned unless explicitly listed.
   */
  readonly entityIds?: readonly string[];
}

export interface PatternSketchResult {
  /** Full model with seed + patterned copies and replicated constraints. */
  readonly model: SketchModel;
  /** Ids of entities created by the pattern (not including the seed). */
  readonly createdEntityIds: string[];
  /** Ids of constraints created by the pattern. */
  readonly createdConstraintIds: string[];
}

const MAX_COUNT = 10_000;
const FULL_TURN = 2 * Math.PI;
const FULL_TURN_TOL = 1e-9;

function checkCount(count: number): void {
  if (!Number.isFinite(count) || count < 1 || !Number.isInteger(count)) {
    throw new Error("patternSketch: count must be an integer ≥ 1");
  }
  if (count > MAX_COUNT) {
    throw new Error(`patternSketch: count ${count} exceeds the maximum of ${MAX_COUNT}`);
  }
}

function unit2(d: readonly [number, number]): [number, number] {
  const len = Math.hypot(d[0], d[1]);
  if (len < 1e-15) throw new Error("patternSketch: direction must be a non-zero vector");
  return [d[0] / len, d[1] / len];
}

function isFullTurn(angle: number): boolean {
  const a = Math.abs(angle);
  return Math.abs(a - FULL_TURN) < FULL_TURN_TOL || Math.abs(a) < FULL_TURN_TOL;
}

/** Affine map: translate then optional rotate about a center (for circular). */
type InstanceMap = (u: number, v: number) => { u: number; v: number };

function linearMap(dir: [number, number], spacing: number, i: number): InstanceMap {
  const du = dir[0] * spacing * i;
  const dv = dir[1] * spacing * i;
  return (u, v) => ({ u: u + du, v: v + dv });
}

function circularMap(center: readonly [number, number], angle: number, i: number): InstanceMap {
  const c = Math.cos(angle * i);
  const s = Math.sin(angle * i);
  const [cx, cy] = center;
  return (u, v) => {
    const x = u - cx;
    const y = v - cy;
    return { u: cx + c * x - s * y, v: cy + s * x + c * y };
  };
}

function collectSeedEntityIds(model: SketchModel, explicit?: readonly string[]): Set<string> {
  if (explicit) return new Set(explicit);
  return new Set(model.entities.filter((e) => !e.construction).map((e) => e.id));
}

/** Point ids referenced by the seed entities. */
function seedPointIds(model: SketchModel, entityIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const e of model.entities) {
    if (!entityIds.has(e.id)) continue;
    switch (e.kind) {
      case "line":
        ids.add(e.a);
        ids.add(e.b);
        break;
      case "circle":
        ids.add(e.center);
        break;
      case "arc":
        ids.add(e.a);
        ids.add(e.b);
        ids.add(e.through);
        break;
      case "spline":
        for (const p of e.points) ids.add(p);
        break;
      case "ellipse":
        ids.add(e.center);
        ids.add(e.focus1);
        break;
      case "offset":
        break;
    }
  }
  return ids;
}

/**
 * Constraints wholly internal to the seed (every referenced entity/point id is
 * in the seed set). These are safe to replicate onto each copy.
 */
function internalConstraints(
  model: SketchModel,
  entityIds: Set<string>,
  pointIds: Set<string>,
): SketchConstraint[] {
  const out: SketchConstraint[] = [];
  for (const c of model.constraints) {
    if (constraintRefsInside(c, entityIds, pointIds)) out.push(c);
  }
  return out;
}

function constraintRefsInside(
  c: SketchConstraint,
  entityIds: Set<string>,
  pointIds: Set<string>,
): boolean {
  switch (c.kind) {
    case "horizontal":
    case "vertical":
    case "lineAngle":
      return entityIds.has(c.line);
    case "coincident":
      return pointIds.has(c.a) && pointIds.has(c.b);
    case "parallel":
    case "perpendicular":
    case "equalLength":
    case "angle":
      return entityIds.has(c.line1) && entityIds.has(c.line2);
    case "distance":
    case "hDistance":
    case "vDistance":
      return pointIds.has(c.a) && pointIds.has(c.b);
    case "radius":
    case "diameter":
      return entityIds.has(c.circle);
    case "concentric":
      return entityIds.has(c.circle1) && entityIds.has(c.circle2);
    case "equalRadius":
      return entityIds.has(c.curve1) && entityIds.has(c.curve2);
    case "tangent":
      return "line" in c
        ? entityIds.has(c.line) && entityIds.has(c.circle)
        : entityIds.has(c.curve1) && entityIds.has(c.curve2);
    case "midpoint":
      return pointIds.has(c.point) && entityIds.has(c.line);
    case "pointOnObject":
      return pointIds.has(c.point) && entityIds.has(c.object);
    case "symmetric":
      return pointIds.has(c.a) && pointIds.has(c.b) && entityIds.has(c.axis);
    default:
      return false;
  }
}

function remapConstraint(
  c: SketchConstraint,
  mapEntity: (id: string) => string,
  mapPoint: (id: string) => string,
  newId: string,
): SketchConstraint {
  switch (c.kind) {
    case "horizontal":
    case "vertical":
      return { id: newId, kind: c.kind, line: mapEntity(c.line) };
    case "coincident":
      return { id: newId, kind: "coincident", a: mapPoint(c.a), b: mapPoint(c.b) };
    case "parallel":
    case "perpendicular":
    case "equalLength":
      return {
        id: newId,
        kind: c.kind,
        line1: mapEntity(c.line1),
        line2: mapEntity(c.line2),
      };
    case "distance":
    case "hDistance":
    case "vDistance":
      return {
        id: newId,
        kind: c.kind,
        a: mapPoint(c.a),
        b: mapPoint(c.b),
        value: c.value,
        ...(c.driven ? { driven: true } : {}),
      };
    case "angle":
      return {
        id: newId,
        kind: "angle",
        line1: mapEntity(c.line1),
        line2: mapEntity(c.line2),
        value: c.value,
        ...(c.driven ? { driven: true } : {}),
      };
    case "lineAngle":
      return {
        id: newId,
        kind: "lineAngle",
        line: mapEntity(c.line),
        value: c.value,
        ...(c.driven ? { driven: true } : {}),
      };
    case "radius":
    case "diameter":
      return {
        id: newId,
        kind: c.kind,
        circle: mapEntity(c.circle),
        value: c.value,
        ...(c.driven ? { driven: true } : {}),
      };
    case "concentric":
      return {
        id: newId,
        kind: "concentric",
        circle1: mapEntity(c.circle1),
        circle2: mapEntity(c.circle2),
      };
    case "equalRadius":
      return {
        id: newId,
        kind: "equalRadius",
        curve1: mapEntity(c.curve1),
        curve2: mapEntity(c.curve2),
      };
    case "tangent":
      return "line" in c
        ? {
            id: newId,
            kind: "tangent",
            line: mapEntity(c.line),
            circle: mapEntity(c.circle),
          }
        : {
            id: newId,
            kind: "tangent",
            curve1: mapEntity(c.curve1),
            curve2: mapEntity(c.curve2),
          };
    case "midpoint":
      return {
        id: newId,
        kind: "midpoint",
        point: mapPoint(c.point),
        line: mapEntity(c.line),
      };
    case "pointOnObject":
      return {
        id: newId,
        kind: "pointOnObject",
        point: mapPoint(c.point),
        object: mapEntity(c.object),
      };
    case "symmetric":
      return {
        id: newId,
        kind: "symmetric",
        a: mapPoint(c.a),
        b: mapPoint(c.b),
        axis: mapEntity(c.axis),
      };
  }
}

function cloneEntity(
  e: SketchEntity,
  newId: string,
  mapPoint: (id: string) => string,
  mapEntity: (id: string) => string,
): SketchEntity {
  switch (e.kind) {
    case "line": {
      const line: LineEntity = {
        id: newId,
        kind: "line",
        a: mapPoint(e.a),
        b: mapPoint(e.b),
        ...(e.construction ? { construction: true } : {}),
      };
      return line;
    }
    case "circle": {
      const circ: CircleEntity = {
        id: newId,
        kind: "circle",
        center: mapPoint(e.center),
        radius: e.radius,
        ...(e.construction ? { construction: true } : {}),
      };
      return circ;
    }
    case "arc": {
      const arc: ArcEntity = {
        id: newId,
        kind: "arc",
        a: mapPoint(e.a),
        b: mapPoint(e.b),
        through: mapPoint(e.through),
        ...(e.construction ? { construction: true } : {}),
      };
      return arc;
    }
    case "spline": {
      const spline: SplineEntity = {
        id: newId,
        kind: "spline",
        points: e.points.map(mapPoint),
        ...(e.construction ? { construction: true } : {}),
      };
      return spline;
    }
    case "ellipse": {
      const ellipse: EllipseEntity = {
        id: newId,
        kind: "ellipse",
        center: mapPoint(e.center),
        focus1: mapPoint(e.focus1),
        radmin: e.radmin,
        ...(e.construction ? { construction: true } : {}),
      };
      return ellipse;
    }
    case "offset": {
      const offset: OffsetEntity = {
        id: newId,
        kind: "offset",
        source: mapEntity(e.source),
        distance: e.distance,
        ...(e.construction ? { construction: true } : {}),
      };
      return offset;
    }
  }
}

/**
 * Pattern selected (or all non-construction) sketch entities.
 *
 * Instance 0 is the seed (unchanged). Instances 1…count−1 are transformed
 * copies. Constraints that reference only seed entities/points are replicated
 * onto each copy with remapped ids. Cross-seed constraints are left alone.
 */
export function patternSketch(
  model: SketchModel,
  params: SketchPatternParams,
  opts?: PatternSketchOptions,
): PatternSketchResult {
  checkCount(params.count);

  if (params.kind === "linear" && params.count > 1) {
    if (!Number.isFinite(params.spacing) || params.spacing === 0) {
      throw new Error("patternSketch: linear spacing must be non-zero for count > 1");
    }
  }

  let seq = 0;
  const makeId =
    opts?.makeId ??
    ((prefix: "p" | "e" | "c"): string => {
      seq += 1;
      return `pat_${prefix}${seq}`;
    });

  const seedEntities = collectSeedEntityIds(model, opts?.entityIds);
  if (seedEntities.size === 0) {
    return { model, createdEntityIds: [], createdConstraintIds: [] };
  }
  // Validate explicit ids exist.
  for (const id of seedEntities) {
    if (!model.entities.some((e) => e.id === id)) {
      throw new Error(`patternSketch: unknown entity id "${id}"`);
    }
  }

  const seedPoints = seedPointIds(model, seedEntities);
  const seedConstraints = internalConstraints(model, seedEntities, seedPoints);

  const points: SketchPoint[] = model.points.map((p) => ({ ...p }));
  const entities: SketchEntity[] = model.entities.map((e) => ({ ...e }));
  const constraints: SketchConstraint[] = model.constraints.map((c) => ({ ...c }));
  const createdEntityIds: string[] = [];
  const createdConstraintIds: string[] = [];

  const dir = params.kind === "linear" ? unit2(params.direction) : null;
  const angleTotal = params.kind === "circular" ? (params.angle ?? FULL_TURN) : 0;
  const stepAngle =
    params.kind === "circular"
      ? isFullTurn(angleTotal)
        ? (Math.sign(angleTotal || 1) * FULL_TURN) / params.count
        : params.count > 1
          ? angleTotal / (params.count - 1)
          : 0
      : 0;

  for (let i = 1; i < params.count; i++) {
    const map: InstanceMap =
      params.kind === "linear"
        ? linearMap(dir!, params.spacing, i)
        : circularMap(params.center, stepAngle, i);

    const pointMap = new Map<string, string>();
    for (const pid of seedPoints) {
      const src = model.points.find((p) => p.id === pid);
      if (!src) continue;
      const { u, v } = map(src.u, src.v);
      const nid = makeId("p");
      pointMap.set(pid, nid);
      points.push({
        id: nid,
        u,
        v,
        ...(src.fixed ? { fixed: true } : {}),
      });
    }

    const entityMap = new Map<string, string>();
    const mapPoint = (id: string): string => pointMap.get(id) ?? id;
    for (const e of model.entities) {
      if (seedEntities.has(e.id)) entityMap.set(e.id, makeId("e"));
    }
    const mapEntity = (id: string): string => entityMap.get(id) ?? id;
    for (const e of model.entities) {
      if (!seedEntities.has(e.id)) continue;
      const nid = entityMap.get(e.id)!;
      entities.push(cloneEntity(e, nid, mapPoint, mapEntity));
      createdEntityIds.push(nid);
    }
    for (const c of seedConstraints) {
      const nid = makeId("c");
      constraints.push(remapConstraint(c, mapEntity, mapPoint, nid));
      createdConstraintIds.push(nid);
    }
  }

  return {
    model: {
      ...model,
      points,
      entities,
      constraints,
    },
    createdEntityIds,
    createdConstraintIds,
  };
}
