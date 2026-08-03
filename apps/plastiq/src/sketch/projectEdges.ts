// §13.3 project-body-edges-into-sketch — app half.
//
// Takes planar (u,v) segments (from the kernel's `sectionCurvesToPlaneSegments`
// or `worldPolylinesToPlaneSegments`) and appends them to a SketchModel as
// construction lines. Pure: no React, no OCCT, no store.

import type { PlaneSegment2 } from "@plastiq/cad";
import type { LineEntity, SketchModel, SketchPoint } from "./model.js";

export interface AppendProjectedOptions {
  /** Mark projected entities as construction (default true — reference geometry). */
  readonly construction?: boolean;
  /** Optional fixed flag on projected endpoints (default true — projected refs are fixed). */
  readonly fixed?: boolean;
  /** Id factory; defaults to a local counter (tests / pure callers). */
  readonly makeId?: (prefix: "p" | "e") => string;
  /**
   * Merge an endpoint with an existing model point when within this distance
   * (SI metres). Default 1e-9 — keeps shared corners of a section rectangle
   * as one vertex without accidental coalescing of distinct geometry.
   */
  readonly coalesceTol?: number;
}

/**
 * Append projected plane segments to `model` as construction line entities.
 *
 * Each segment becomes two points (or reuses coalesced endpoints) + one line.
 * Existing model content is preserved; the return value is a new SketchModel.
 */
export function appendProjectedSegments(
  model: SketchModel,
  segments: readonly PlaneSegment2[],
  opts?: AppendProjectedOptions,
): SketchModel {
  if (segments.length === 0) return model;

  const construction = opts?.construction ?? true;
  const fixed = opts?.fixed ?? true;
  const tol = opts?.coalesceTol ?? 1e-9;
  let seq = 0;
  const makeId =
    opts?.makeId ??
    ((prefix: "p" | "e"): string => {
      seq += 1;
      return `proj_${prefix}${seq}`;
    });

  const points: SketchPoint[] = model.points.map((p) => ({ ...p }));
  const entities: SketchModel["entities"] = model.entities.map((e) => ({ ...e }));

  const findNear = (u: number, v: number): string | null => {
    for (const p of points) {
      if (Math.hypot(p.u - u, p.v - v) <= tol) return p.id;
    }
    return null;
  };

  const ensurePoint = (uv: readonly [number, number]): string => {
    const existing = findNear(uv[0], uv[1]);
    if (existing) return existing;
    const id = makeId("p");
    points.push({ id, u: uv[0], v: uv[1], fixed: fixed || undefined });
    return id;
  };

  for (const seg of segments) {
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    if (len < tol) continue;
    const a = ensurePoint(seg.a);
    const b = ensurePoint(seg.b);
    if (a === b) continue;
    const line: LineEntity = {
      id: makeId("e"),
      kind: "line",
      a,
      b,
      construction: construction || undefined,
    };
    entities.push(line);
  }

  return {
    ...model,
    points,
    entities,
    constraints: model.constraints.map((c) => ({ ...c })),
  };
}
