// Finish-sketch profile extraction (SPEC-5 M3.7, FR-21). The sketch model is the
// parametric source of truth (constraints persisted); the *profile* a feature
// consumes is DERIVED from the solved geometry. Pure (no DOM/kernel), so it is
// unit-tested; the worker's rebuild then lowers this typed profile into the
// kernel Sketch (lines → polygon, line+arc → MakeWire, circle → curved edge) and
// extrudes/cuts/revolves it.
//
// Construction geometry is excluded (FR-21). Two shapes are recognised:
//   • a closed loop of non-construction line / arc / spline segments, or
//   • a single non-construction circle (centre + radius), which the kernel
//     builds as a true arc edge (extrudes to a real cylinder, not a facet poly).

import type { ArcEntity, LineEntity, SketchModel, SplineEntity } from "./model.js";

/** One piece of a loop profile, starting at the previous segment's end. */
export type ProfileSegment =
  | { kind: "line"; to: [number, number] }
  | { kind: "arc"; through: [number, number]; to: [number, number] }
  | { kind: "spline"; through: [number, number][]; to: [number, number] };

/** A circular hole inside a loop profile (plane UV). */
export type ProfileHole = { kind: "circle"; center: [number, number]; radius: number };

/** The derived, kernel-ready profile shape. */
export type Profile =
  | { kind: "circle"; center: [number, number]; radius: number }
  | {
      kind: "loop";
      start: [number, number];
      segments: ProfileSegment[];
      /** Interior circles treated as holes (T11 / C5). */
      holes?: ProfileHole[];
    };

/** A profile edge with its endpoint point-ids and the source entity. */
interface Edge {
  a: string;
  b: string;
  ent: LineEntity | ArcEntity | SplineEntity;
}

/** The closed loop of non-construction line/arc/spline edges as a typed profile. */
function edgeLoop(model: SketchModel): Profile | null {
  const edges: Edge[] = [];
  for (const e of model.entities) {
    if (e.construction) continue;
    if (e.kind === "line") edges.push({ a: e.a, b: e.b, ent: e });
    else if (e.kind === "arc") edges.push({ a: e.a, b: e.b, ent: e });
    else if (e.kind === "spline" && e.points.length >= 2)
      edges.push({ a: e.points[0]!, b: e.points[e.points.length - 1]!, ent: e });
  }
  if (edges.length < 2) return null;
  // A loop of only straight edges needs ≥ 3 (two lines between the same pair is a
  // degenerate zero-area sliver); a curved edge can close a 2-edge region.
  if (edges.every((e) => e.ent.kind === "line") && edges.length < 3) return null;

  // Vertex → incident edge indices. Every vertex must have degree exactly 2.
  const inc = new Map<string, number[]>();
  edges.forEach((e, i) => {
    (inc.get(e.a) ?? inc.set(e.a, []).get(e.a)!).push(i);
    (inc.get(e.b) ?? inc.set(e.b, []).get(e.b)!).push(i);
  });
  for (const [, ids] of inc) if (ids.length !== 2) return null;

  const coord = (id: string): [number, number] | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? [p.u, p.v] : null;
  };

  // Walk edge→edge, consuming each once, until we return to the start vertex.
  const startV = edges[0]!.a;
  const startCoord = coord(startV);
  if (!startCoord) return null;
  const used = new Set<number>();
  const segments: ProfileSegment[] = [];
  let cur = startV;
  let guard = edges.length + 1;
  while (guard-- > 0) {
    const next = inc.get(cur)!.find((i) => !used.has(i));
    if (next === undefined) break;
    used.add(next);
    const e = edges[next]!;
    const toV = e.a === cur ? e.b : e.a;
    const toCoord = coord(toV);
    if (!toCoord) return null;
    if (e.ent.kind === "arc") {
      const through = coord(e.ent.through);
      if (!through) return null;
      segments.push({ kind: "arc", through, to: toCoord });
    } else if (e.ent.kind === "spline") {
      // Interpolation points after the segment start, in traversal direction.
      const ids =
        e.ent.points[0] === cur ? e.ent.points.slice(1) : [...e.ent.points].reverse().slice(1);
      const through: [number, number][] = [];
      for (const pid of ids) {
        const c = coord(pid);
        if (!c) return null;
        through.push(c);
      }
      segments.push({ kind: "spline", through, to: toCoord });
    } else {
      segments.push({ kind: "line", to: toCoord });
    }
    cur = toV;
    if (cur === startV) break;
  }
  // A single closed cycle consumes every edge and lands back on the start.
  if (used.size !== edges.length || cur !== startV) return null;
  // Drop the final segment's redundant landing back on `start` only if the walk
  // double-counted; here the last segment legitimately closes onto start, so keep
  // all segments (the kernel auto-closes if the last point ≠ start, but ours does
  // land on start — its `to` equals start, which the kernel treats as closing).
  const holes = interiorCircles(model, startCoord, segments);
  return holes.length > 0
    ? { kind: "loop", start: startCoord, segments, holes }
    : { kind: "loop", start: startCoord, segments };
}

/** Ray-cast point-in-polygon for the outer loop (C9 — true containment for holes). */
function pointInOuterLoop(
  u: number,
  v: number,
  start: [number, number],
  segments: ProfileSegment[],
): boolean {
  // Build polyline ring of sample points along the outer path.
  const ring: [number, number][] = [start];
  let cur: [number, number] = start;
  for (const seg of segments) {
    if (seg.kind === "arc") {
      // Sample the arc mid (through) plus endpoint — enough for containment of circle centres.
      ring.push(seg.through, seg.to);
    } else if (seg.kind === "spline") {
      for (const p of seg.through) ring.push(p);
      ring.push(seg.to);
    } else {
      ring.push(seg.to);
    }
    cur = seg.to;
  }
  if (ring.length < 3) return false;
  // Standard even-odd ray cast in UV.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ui, vi] = ring[i]!;
    const [uj, vj] = ring[j]!;
    const intersect =
      vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi + 1e-30) + ui;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Non-construction circles whose centres lie strictly inside the outer loop (C9). */
function interiorCircles(
  model: SketchModel,
  start: [number, number],
  segments: ProfileSegment[],
): ProfileHole[] {
  const holes: ProfileHole[] = [];
  for (const e of model.entities) {
    if (e.kind !== "circle" || e.construction) continue;
    const centre = model.points.find((p) => p.id === e.center);
    if (!centre || !(e.radius > 0)) continue;
    if (!pointInOuterLoop(centre.u, centre.v, start, segments)) continue;
    holes.push({ kind: "circle", center: [centre.u, centre.v], radius: e.radius });
  }
  return holes;
}

/** The single non-construction circle, as a circle profile (or null). */
function soleCircle(model: SketchModel): Profile | null {
  const circles = model.entities.filter((e) => e.kind === "circle" && !e.construction);
  const others = model.entities.filter(
    (e) => (e.kind === "line" || e.kind === "arc" || e.kind === "spline") && !e.construction,
  );
  if (circles.length !== 1 || others.length > 0) return null;
  const c = circles[0]!;
  if (c.kind !== "circle") return null;
  const centre = model.points.find((p) => p.id === c.center);
  if (!centre || !(c.radius > 0)) return null;
  return { kind: "circle", center: [centre.u, centre.v], radius: c.radius };
}

/** Is `v` a buildable profile? Validates a deserialized (persisted) payload. */
export function isProfile(v: unknown): v is Profile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<Profile>;
  if (p.kind === "circle") {
    const c = (v as { center?: unknown }).center;
    const r = (v as { radius?: unknown }).radius;
    return Array.isArray(c) && c.length === 2 && typeof r === "number" && r > 0;
  }
  if (p.kind === "loop") {
    const s = (v as { start?: unknown }).start;
    const segs = (v as { segments?: unknown }).segments;
    if (!Array.isArray(s) || s.length !== 2 || !Array.isArray(segs)) return false;
    return segs.every((g) => {
      if (typeof g !== "object" || g === null) return false;
      const k = (g as { kind?: unknown }).kind;
      if (k === "line") return Array.isArray((g as { to?: unknown }).to);
      if (k === "arc")
        return (
          Array.isArray((g as { to?: unknown }).to) &&
          Array.isArray((g as { through?: unknown }).through)
        );
      if (k === "spline") {
        const to = (g as { to?: unknown }).to;
        const through = (g as { through?: unknown }).through;
        return Array.isArray(to) && Array.isArray(through) && through.length >= 1;
      }
      return false;
    });
  }
  return false;
}

/**
 * The derived profile for this sketch, or null if the non-construction geometry
 * doesn't form a buildable closed profile (one line/arc loop, or one circle).
 */
export function extractProfile(model: SketchModel): Profile | null {
  return edgeLoop(model) ?? soleCircle(model);
}
