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

/** A hole inside a loop profile (plane UV): a full circle, or an inner loop of
 * line/arc/spline segments (§2.7 — a rectangular/shaped hole, not just a drill). */
export type ProfileHole =
  | { kind: "circle"; center: [number, number]; radius: number }
  | { kind: "loop"; start: [number, number]; segments: ProfileSegment[] };

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

/** One extracted closed cycle: its start point and the ordered segment chain. */
interface Cycle {
  start: [number, number];
  segments: ProfileSegment[];
}

/**
 * The non-construction line/arc/spline geometry as a typed loop profile.
 *
 * Extracts ALL closed cycles, not just one (§2.7). The classic failure was a
 * plate-with-a-hole (two disjoint loops): the old walk consumed a single cycle
 * and, finding leftover edges, returned null — so drawing a hole broke the WHOLE
 * previously-working sketch with "no buildable profile". Now the loops are
 * classified by even-odd containment: the single outer boundary becomes the
 * profile and the loops inside it become holes (alongside any interior circles).
 *
 * Deliberately still returns null (an honest failure, unchanged) for cases this
 * profile shape cannot represent: multiple disjoint OUTER regions, or nested
 * islands (a solid inside a hole) — never a silently-dropped region.
 */
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

  // Vertex → incident edge indices. Every vertex must have degree exactly 2 — this
  // is what guarantees the geometry is a set of DISJOINT simple closed loops (a
  // shared vertex would be degree 4 and is rejected), so the cycles are
  // vertex-disjoint and a cycle's own vertex is strictly inside/outside any other.
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

  const used = new Set<number>();
  /** Walk the cycle reachable from the unused edge `seed`, consuming its edges. */
  const walkFrom = (seed: number): Cycle | null => {
    const startV = edges[seed]!.a;
    const startCoord = coord(startV);
    if (!startCoord) return null;
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
    // The walk must close back on its start (a valid simple loop).
    return cur === startV ? { start: startCoord, segments } : null;
  };

  const cycles: Cycle[] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    const c = walkFrom(i);
    if (!c) return null;
    cycles.push(c);
  }
  // Every edge must belong to exactly one closed cycle.
  if (used.size !== edges.length || cycles.length === 0) return null;

  // Classify by even-odd containment. A cycle's start vertex sits ON its own
  // boundary but strictly inside/outside every OTHER (disjoint) cycle, so it is a
  // safe representative point. depth = how many other cycles contain it.
  const rings = cycles.map((c) => ringOf(c.start, c.segments));
  const depth = cycles.map((c, i) =>
    cycles.reduce((n, _c, j) => (j !== i && pointInRing(c.start, rings[j]!) ? n + 1 : n), 0),
  );

  // Exactly one outermost (depth 0) boundary. Zero or several ⇒ no single region
  // this profile shape can hold ⇒ honest null (never a dropped region).
  const outerIdxs = depth.flatMap((d, i) => (d === 0 ? [i] : []));
  if (outerIdxs.length !== 1) return null;
  const oi = outerIdxs[0]!;

  // Loops directly inside the boundary (depth 1) are holes; anything deeper is a
  // nested island this shape cannot represent ⇒ honest null.
  const loopHoles: ProfileHole[] = [];
  for (let i = 0; i < cycles.length; i++) {
    if (i === oi) continue;
    if (depth[i] !== 1) return null;
    loopHoles.push({ kind: "loop", start: cycles[i]!.start, segments: cycles[i]!.segments });
  }

  const outer = cycles[oi]!;
  const circleHoles = interiorCircles(model, outer.start, outer.segments);
  const holes = [...loopHoles, ...circleHoles];
  return holes.length > 0
    ? { kind: "loop", start: outer.start, segments: outer.segments, holes }
    : { kind: "loop", start: outer.start, segments: outer.segments };
}

/** A closed loop as a polyline ring of sample UV points (arcs/splines sampled by
 * their through + end points — enough for even-odd containment). */
function ringOf(start: [number, number], segments: ProfileSegment[]): [number, number][] {
  const ring: [number, number][] = [start];
  for (const seg of segments) {
    if (seg.kind === "arc") {
      ring.push(seg.through, seg.to);
    } else if (seg.kind === "spline") {
      for (const p of seg.through) ring.push(p);
      ring.push(seg.to);
    } else {
      ring.push(seg.to);
    }
  }
  return ring;
}

/** Even-odd ray-cast point-in-polygon for a ring (C9 — true containment). */
function pointInRing(p: [number, number], ring: [number, number][]): boolean {
  if (ring.length < 3) return false;
  const [u, v] = p;
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
  const ring = ringOf(start, segments);
  const holes: ProfileHole[] = [];
  for (const e of model.entities) {
    if (e.kind !== "circle" || e.construction) continue;
    const centre = model.points.find((p) => p.id === e.center);
    if (!centre || !(e.radius > 0)) continue;
    if (!pointInRing([centre.u, centre.v], ring)) continue;
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
    if (!segs.every(isSegment)) return false;
    // Holes are optional; when present each is a circle or an inner loop (§2.7).
    const holes = (v as { holes?: unknown }).holes;
    if (holes !== undefined) {
      if (!Array.isArray(holes)) return false;
      if (
        !holes.every((h) => {
          if (typeof h !== "object" || h === null) return false;
          const hk = (h as { kind?: unknown }).kind;
          if (hk === "circle") {
            const c = (h as { center?: unknown }).center;
            const r = (h as { radius?: unknown }).radius;
            return Array.isArray(c) && c.length === 2 && typeof r === "number" && r > 0;
          }
          if (hk === "loop") {
            const hs = (h as { start?: unknown }).start;
            const hsegs = (h as { segments?: unknown }).segments;
            return (
              Array.isArray(hs) && hs.length === 2 && Array.isArray(hsegs) && hsegs.every(isSegment)
            );
          }
          return false;
        })
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** Validate one deserialized ProfileSegment (line / arc / spline). */
function isSegment(g: unknown): boolean {
  if (typeof g !== "object" || g === null) return false;
  const k = (g as { kind?: unknown }).kind;
  if (k === "line") return Array.isArray((g as { to?: unknown }).to);
  if (k === "arc")
    return (
      Array.isArray((g as { to?: unknown }).to) && Array.isArray((g as { through?: unknown }).through)
    );
  if (k === "spline") {
    const to = (g as { to?: unknown }).to;
    const through = (g as { through?: unknown }).through;
    return Array.isArray(to) && Array.isArray(through) && through.length >= 1;
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
