// Persistent-ref resolution (SPEC-4 FR-16). The inverse of signature generation:
// given a FaceRef/EdgeRef captured before an edit, find the matching face/edge in
// the *current* solid by its signature (face outward normal; edge adjacent-face
// normal pair). This is what lets a fillet/chamfer/shell re-resolve to the same
// topology after an upstream parameter rebuild.
//
// Returned shapes are owned by the caller (call `.delete()` when done).

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Vertex, TopTools_ListOfShape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { dot, normalize, sub, type Vec3 } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import {
  adjacentFaceNormals,
  edgeMidpoint,
  ensureMeshed,
  faceCentroid,
  faceNormal,
  shapeEnums,
} from "./normals.js";
import { faceSurfaceSignature, surfacesMatch, type SurfaceSignature } from "./surface.js";
import type { EdgeRef, FaceRef, VertexRef } from "./tagged.js";

// A face matches if its normal aligns to within ~2.6° (dot ≥ 0.999).
const FACE_DOT_TOL = 0.999;
// An edge matches if both adjacent normals align (summed dot ≥ 2·tol).
const EDGE_SCORE_TOL = 2 * FACE_DOT_TOL;

/** Squared distance between two points (cheaper than distance for comparison). */
function sqDist(a: Vec3, b: Vec3): number {
  const d = sub(a, b);
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
}

/**
 * The current solid's face matching `ref`, or null (caller deletes).
 *
 * The normal is the primary filter (only faces aligned within tolerance are
 * candidates). When `ref.centroid` is present it disambiguates among those
 * candidates by closest area-centroid — so two faces sharing a normal (coplanar
 * faces, a step, parallel walls) resolve to the RIGHT one rather than whichever
 * OCCT enumerated first. Without a centroid (refs persisted before it existed) it
 * falls back to the best normal alignment.
 */
export function resolveFaceRef(oc: Occt, solid: Solid, ref: FaceRef): TopoDS_Face | null {
  ensureMeshed(oc, solid.shape);
  // Cap for the positional tie-break, scaled to the model (§2.1). Without it a
  // ref whose face a boolean DELETED silently rebound to any same-signature face
  // arbitrarily far away — a wrong result with no error.
  const cap = centroidCap(oc, solid);
  const hasPos = ref.centroid != null;
  if (ref.surface) {
    // PRIMARY (§2.1): exact analytic-surface match — mesh-independent, and the
    // only signature that works for a closed curved face.
    let hit = scanFaces(oc, solid, ref, "surface");
    if (hit.best) return capReject(hit.best, hit.bestScore, cap, hasPos);
    // FALLBACK 1 (R1/§4.3): the exact match failed because the face MOVED or was
    // RESIZED (plane offset, hole translated, hole-diameter change) — its
    // analytic params drifted but the face still exists. Match by surface KIND +
    // closest centroid. This resolves CLOSED CURVED faces too, whose averaged
    // normal is meaningless residue and so is useless to the legacy path — that
    // residue is exactly why the old code returned null here (the moved-face
    // cliff, §4.3), latent before R1 only because production never sent
    // surface-bearing refs.
    hit = scanFaces(oc, solid, ref, "kind");
    if (hit.best) return capReject(hit.best, hit.bestScore, cap, hasPos);
    // FALLBACK 2: no same-kind face survived either — drop to the legacy normal
    // path as the final safe attempt before failing loudly.
  }
  // LEGACY path: refs persisted before `surface` existed, or the fallbacks above.
  const hit = scanFaces(oc, solid, ref, "legacy");
  return hit.best ? capReject(hit.best, hit.bestScore, cap, hasPos) : null;
}

type FaceScanMode = "surface" | "kind" | "legacy";

/** One scoring pass over the solid's faces. `mode` selects the filter: exact
 * analytic `surface` match, same-surface-`kind` match (the moved/resized-face
 * fallback), or the `legacy` outward-normal filter. The winner is the closest
 * centroid when the ref carries one, else the first in-tolerance candidate. */
function scanFaces(
  oc: Occt,
  solid: Solid,
  ref: FaceRef,
  mode: FaceScanMode,
): { best: TopoDS_Face | null; bestScore: number } {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let best: TopoDS_Face | null = null;
  let bestScore = -Infinity;
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    let score: number;
    if (mode === "legacy") {
      const aligned = dot(faceNormal(oc, face), ref.normal);
      if (aligned < FACE_DOT_TOL) {
        face.delete();
        continue;
      }
      score = ref.centroid ? -sqDist(faceCentroid(oc, face), ref.centroid) : aligned;
    } else {
      const sig = faceSurfaceSignature(oc, face);
      const ok = mode === "surface" ? surfacesMatch(ref.surface!, sig) : ref.surface!.kind === sig.kind;
      if (!ok) {
        face.delete();
        continue;
      }
      // Same surface/kind can still be several faces (coplanar fragments; the two
      // walls of a through-hole are ONE cylinder). Closest centroid wins.
      score = ref.centroid ? -sqDist(faceCentroid(oc, face), ref.centroid) : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = face;
    } else {
      face.delete();
    }
  }
  exp.delete();
  return { best, bestScore };
}

/** Enforce the positional cap: a candidate whose centroid/midpoint is
 * implausibly far from the ref's is not the referenced entity — fail LOUDLY
 * (null, freeing the shape) rather than rebind. Returns the shape when it
 * passes, null when it is rejected. */
function capReject<T extends { delete(): void }>(
  best: T,
  bestScore: number,
  cap: number,
  hasPositional: boolean,
): T | null {
  if (hasPositional && bestScore !== -Infinity && -bestScore > cap * cap) {
    best.delete();
    return null;
  }
  return best;
}

/**
 * Max distance a re-resolved face/edge's centroid may sit from the ref's, in
 * SI metres — the diagonal of the solid's bounding box, so it scales with the
 * model instead of hard-coding a length.
 *
 * The bound is deliberately generous: a legitimate face can travel a long way
 * when an upstream parameter changes (that is the point of a parametric ref).
 * It exists to reject the pathological case — the referenced face was DELETED
 * and the nearest same-signature candidate is somewhere else entirely.
 */
function centroidCap(oc: Occt, solid: Solid): number {
  void oc;
  const { min, max } = solid.boundingBox();
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/**
 * The current solid's edge matching `ref`, or null (caller deletes).
 *
 * When `ref.faceSurfaces` is present the adjacent faces' ANALYTIC surfaces are
 * the filter (§2.1) — the only signature that works for an edge bordering a
 * closed curved wall (a hole rim, a boss edge), whose averaged normal on that
 * side is meaningless residue. Older refs fall back to the adjacent-normal pair.
 * Either way `ref.midpoint` separates parallel edges sharing the same adjacent
 * faces, and the same distance cap as {@link resolveFaceRef} applies.
 */
export function resolveEdgeRef(oc: Occt, solid: Solid, ref: EdgeRef): TopoDS_Edge | null {
  ensureMeshed(oc, solid.shape);
  const cap = centroidCap(oc, solid);
  const hasPos = ref.midpoint != null;
  if (ref.faceSurfaces) {
    // PRIMARY (§2.1): exact adjacent-surface match — the only signature that
    // identifies an edge bordering a closed curved wall (hole rim, boss edge).
    let hit = scanEdges(oc, solid, ref, "surface");
    if (hit.best) return capReject(hit.best, hit.bestScore, cap, hasPos);
    // FALLBACK 1 (R1/§4.3): the adjacent surfaces drifted (a hole rim after a
    // diameter change or translation) so their exact signatures no longer match.
    // Match by adjacent-surface KIND pair + closest midpoint — this resolves
    // rim/boss edges on curved walls, which the residue-normal legacy path below
    // cannot (that residue is why such an edge used to resolve to null, §4.3).
    hit = scanEdges(oc, solid, ref, "kind");
    if (hit.best) return capReject(hit.best, hit.bestScore, cap, hasPos);
    // FALLBACK 2: no same-kind edge survived — final legacy attempt before null.
  }
  const hit = scanEdges(oc, solid, ref, "legacy");
  return hit.best ? capReject(hit.best, hit.bestScore, cap, hasPos) : null;
}

type EdgeScanMode = "surface" | "kind" | "legacy";

/** One scoring pass over the solid's edges (via the edge→face ancestor map).
 * `mode` selects the filter: exact adjacent-`surface` match, adjacent-surface
 * `kind`-pair match (the moved/resized fallback), or the `legacy`
 * adjacent-normal-pair filter; ties broken by closest midpoint when present. */
function scanEdges(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
  mode: EdgeScanMode,
): { best: TopoDS_Edge | null; bestScore: number } {
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_EDGE, S.TopAbs_FACE, map);
  let best: TopoDS_Edge | null = null;
  let bestScore = -Infinity;
  const count = map.Extent();
  for (let i = 1; i <= count; i++) {
    const faceList = map.FindFromIndex(i);
    const edge = oc.TopoDS.Edge_1(map.FindKey(i));
    let score: number;
    if (mode !== "legacy") {
      const pair = adjacentFaceSurfaces(oc, faceList);
      const ok =
        pair != null &&
        (mode === "surface" ? surfacePairMatches(pair, ref.faceSurfaces!) : kindPairMatches(pair, ref.faceSurfaces!));
      if (!ok) {
        edge.delete();
        continue;
      }
      score = ref.midpoint ? -sqDist(edgeMidpoint(oc, edge), ref.midpoint) : 0;
    } else {
      const [a, b] = adjacentFaceNormals(oc, faceList);
      // Order-independent: the ref's two normals may be stored in either order.
      const s1 = dot(a, ref.faceNormals[0]) + dot(b, ref.faceNormals[1]);
      const s2 = dot(a, ref.faceNormals[1]) + dot(b, ref.faceNormals[0]);
      const normalScore = Math.max(s1, s2);
      if (normalScore < EDGE_SCORE_TOL) {
        edge.delete();
        continue;
      }
      score = ref.midpoint ? -sqDist(edgeMidpoint(oc, edge), ref.midpoint) : normalScore;
    }
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = edge;
    } else {
      edge.delete();
    }
  }
  map.delete();
  return { best, bestScore };
}

/** The two adjacent faces' analytic surfaces for an edge, or null if it does
 * not border exactly two faces (a seam/free edge). */
function adjacentFaceSurfaces(
  oc: Occt,
  faceList: { Extent(): number; First_1(): { delete(): void }; Last_1(): { delete(): void } },
): [SurfaceSignature, SurfaceSignature] | null {
  if (faceList.Extent() < 2) return null;
  const f1 = oc.TopoDS.Face_1(faceList.First_1() as never);
  const f2 = oc.TopoDS.Face_1(faceList.Last_1() as never);
  try {
    return [faceSurfaceSignature(oc, f1), faceSurfaceSignature(oc, f2)];
  } finally {
    f1.delete();
    f2.delete();
  }
}

/** Order-independent match of an adjacent-surface pair. */
function surfacePairMatches(
  a: readonly [SurfaceSignature, SurfaceSignature],
  b: readonly [SurfaceSignature, SurfaceSignature],
): boolean {
  return (
    (surfacesMatch(a[0], b[0]) && surfacesMatch(a[1], b[1])) ||
    (surfacesMatch(a[0], b[1]) && surfacesMatch(a[1], b[0]))
  );
}

/** Order-independent match of an adjacent-surface pair by KIND only (plane /
 * cylinder / cone / sphere / torus / other) — the moved/resized-edge fallback
 * (R1/§4.3): a hole rim keeps its [plane, cylinder] kind pair across a diameter
 * change or translation even though the exact analytic params drift. */
function kindPairMatches(
  a: readonly [SurfaceSignature, SurfaceSignature],
  b: readonly [SurfaceSignature, SurfaceSignature],
): boolean {
  return (
    (a[0].kind === b[0].kind && a[1].kind === b[1].kind) ||
    (a[0].kind === b[1].kind && a[1].kind === b[0].kind)
  );
}

/** The unit tangent direction of the edge matching `ref` (start→end). */
export function resolveEdgeDirection(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
): [number, number, number] {
  const d = resolveEdgeAxis(oc, solid, ref).direction;
  return [d[0], d[1], d[2]];
}

/**
 * Origin (edge midpoint) + unit tangent of the edge matching `ref`.
 * Used for revolve-about-edge and any axis-from-edge feature (C2).
 */
export function resolveEdgeAxis(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
): { origin: Vec3; direction: Vec3 } {
  const edge = resolveEdgeRef(oc, solid, ref);
  if (!edge) throw new Error("resolveEdgeAxis: no edge matched the EdgeRef signature");
  try {
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    try {
      const p0 = curve.Value(curve.FirstParameter());
      const p1 = curve.Value(curve.LastParameter());
      const a: Vec3 = [p0.X(), p0.Y(), p0.Z()];
      const b: Vec3 = [p1.X(), p1.Y(), p1.Z()];
      p0.delete();
      p1.delete();
      const direction = normalize(sub(b, a));
      // Prefer the geometric midpoint; fall back to ref.midpoint only if needed
      // (both endpoints coincide would already fail normalize above).
      const origin: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      return { origin, direction };
    } finally {
      curve.delete();
    }
  } finally {
    edge.delete();
  }
}

// Two vertices count as the SAME position when their squared-distance scores to
// the ref differ by less than this (SI metres², from ~OCCT's default linear
// Precision::Confusion) — the threshold at which the adjacent-edge-midpoint
// disambiguator must break a positional tie rather than trust position alone.
const VERTEX_COINCIDENCE = 1e-7;
const VERTEX_COINCIDENCE_SQ = VERTEX_COINCIDENCE * VERTEX_COINCIDENCE;

/** A vertex's B-rep point (its VertexRef signature), via `BRep_Tool.Pnt`. */
function vertexPoint(oc: Occt, vertex: TopoDS_Vertex): Vec3 {
  const p = oc.BRep_Tool.Pnt(vertex);
  const out: Vec3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/**
 * Midpoints of (up to two of) the edges meeting at a vertex — the TOPOLOGICAL
 * adjacency read from its `MapShapesAndAncestors(VERTEX, EDGE)` ancestor list,
 * exactly as `resolveEdgeRef` reads an edge's two adjacent faces from its
 * edge→face ancestors. This must be topological, not positional: two coincident
 * vertices (the touching corners of two compound bodies) share one POSITION but
 * own DISJOINT edges — a position-keyed lookup would hand both of them the union
 * of all edges at that point and disambiguate nothing, whereas each vertex's
 * ancestor list carries only its own edges.
 *
 * The bound `TopTools` API exposes only `First_1`/`Last_1` of that list, so this
 * is a two-edge fingerprint for a >2-valence corner, not the full star. That is
 * sufficient: the disambiguator only needs to SEPARATE coincident vertices, whose
 * edges point in opposing directions, and the nearest-neighbour scoring in
 * {@link midpointSetDistance} tolerates the partial, order-independent set.
 */
function adjacentEdgeMidpoints(oc: Occt, edgeList: TopTools_ListOfShape): Vec3[] {
  const n = edgeList.Extent();
  if (n === 0) return [];
  const out: Vec3[] = [];
  const first = oc.TopoDS.Edge_1(edgeList.First_1());
  out.push(edgeMidpoint(oc, first));
  first.delete();
  if (n >= 2) {
    const last = oc.TopoDS.Edge_1(edgeList.Last_1());
    out.push(edgeMidpoint(oc, last));
    last.delete();
  }
  return out;
}

/** How poorly a candidate vertex's adjacent-edge-midpoint set matches the ref's
 * (lower is better): the summed nearest-neighbour squared distance from each ref
 * midpoint to the closest candidate midpoint. Order-independent and tolerant of
 * a differing count. A candidate with NO adjacent edges is the worst possible
 * match (Infinity) rather than a spurious perfect zero. */
function midpointSetDistance(candidate: readonly Vec3[], ref: readonly Vec3[]): number {
  if (candidate.length === 0) return Infinity;
  let total = 0;
  for (const r of ref) {
    let nearest = Infinity;
    for (const c of candidate) {
      const d = sqDist(c, r);
      if (d < nearest) nearest = d;
    }
    total += nearest;
  }
  return total;
}

/**
 * The current solid's vertex matching `ref`, or null (caller deletes).
 *
 * A vertex has no analytic signature (§12.R12), so `ref.position` — its exact
 * B-rep corner point — is the primary filter: the nearest vertex wins, and the
 * same bounding-box-diagonal cap as {@link resolveFaceRef} rejects a match too
 * far away (fail LOUDLY rather than rebind to an unrelated corner when the
 * referenced vertex was deleted). When `ref.adjacentEdgeMidpoints` is present it
 * breaks a POSITIONAL tie — two vertices sharing one position, e.g. the touching
 * corners of two bodies in a compound — by the closest adjacent-edge-midpoint
 * set. Vertices are enumerated via `MapShapesAndAncestors(VERTEX, EDGE)`, the
 * same unique-key enumeration `tessellate.ts` uses to emit `VertexPoint`s, so a
 * ref captured from a tessellation re-resolves against the same identities.
 */
export function resolveVertexRef(oc: Occt, solid: Solid, ref: VertexRef): TopoDS_Vertex | null {
  ensureMeshed(oc, solid.shape);
  const cap = centroidCap(oc, solid);
  const disambiguate = ref.adjacentEdgeMidpoints != null && ref.adjacentEdgeMidpoints.length > 0;
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_VERTEX, S.TopAbs_EDGE, map);
  let best: TopoDS_Vertex | null = null;
  // Lexicographic key (both lower-is-better): position squared-distance first,
  // adjacent-edge-set distance as the tie-break for coincident positions.
  let bestPos = Infinity;
  let bestEdge = Infinity;
  const count = map.Extent();
  for (let i = 1; i <= count; i++) {
    const vertex = oc.TopoDS.Vertex_1(map.FindKey(i));
    const pos = vertexPoint(oc, vertex);
    const posScore = sqDist(pos, ref.position);
    // Read the disambiguator from THIS vertex's own edge ancestors (topological,
    // so coincident vertices get their disjoint edge sets — see adjacentEdgeMidpoints).
    const edgeScore = disambiguate
      ? midpointSetDistance(adjacentEdgeMidpoints(oc, map.FindFromIndex(i)), ref.adjacentEdgeMidpoints!)
      : 0;
    let better: boolean;
    if (best === null) {
      better = true;
    } else if (Math.abs(posScore - bestPos) > VERTEX_COINCIDENCE_SQ) {
      // Positions differ meaningfully → the nearer one wins outright. (Comparing
      // the DIFFERENCE of squared distances against a squared-linear tol is
      // dimensionally loose in general, but sound here: `ref.position` is captured
      // AT the vertex, so the true match's posScore ≈ 0 and this tie only fires
      // among the near-zero candidates that genuinely share a position.)
      better = posScore < bestPos;
    } else {
      // Coincident positions → the closest adjacent-edge-midpoint set decides.
      better = edgeScore < bestEdge;
    }
    if (better) {
      if (best) best.delete();
      best = vertex;
      bestPos = posScore;
      bestEdge = edgeScore;
    } else {
      vertex.delete();
    }
  }
  map.delete();
  if (!best) return null;
  // Reuse the shared cap: reject when bestPos > cap² (position is always present
  // for a vertex, so hasPositional is unconditionally true).
  return capReject(best, -bestPos, cap, true);
}
