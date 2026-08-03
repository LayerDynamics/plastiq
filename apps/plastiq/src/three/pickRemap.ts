// R4 / S1 — pick invalidation on rebuild.
//
// Picks are stored as transient `{kind, id}` where `id` is the render-group order
// of the CURRENT mesh. A topology-changing rebuild re-numbers those groups, so a
// stale pick id can silently denote a DIFFERENT face/edge — and a dress-up built
// from it then binds the wrong ref. `remapPicks` resolves each pick's STORED ref
// (from the outgoing `selectionRefs`) against the NEW refs by the same signature
// cascade the kernel resolver uses (exact analytic surface → surface KIND →
// legacy normal, closest positional tiebreak), and DROPS any pick whose entity no
// longer resolves. A pick therefore either follows its face/edge or clears — it
// never points at a different entity.

import {
  surfacesMatch,
  type EdgeRef,
  type FaceRef,
  type SurfaceSignature,
  type VertexRef,
} from "@plastiq/cad";
import type { Pick } from "../store/types.js";
import type { SelectionRefs } from "../store/store.js";

type V3 = readonly [number, number, number];

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sqDist = (a: V3, b: V3): number => {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};
const NORMAL_TOL = 0.999; // ~2.6°, the kernel's FACE_DOT_TOL
// Cap for vertex re-bind: squared metres. ~1 m diagonal covers any reasonable
// part resize; beyond that the corner was deleted and the pick must drop (same
// fail-loudly contract as resolveVertexRef's bbox-diagonal cap).
const VERTEX_CAP_SQ = 1;

/** Order-independent exact match of an adjacent-surface pair. */
function surfacePairMatch(
  a: readonly [SurfaceSignature, SurfaceSignature],
  b: readonly [SurfaceSignature, SurfaceSignature],
): boolean {
  return (
    (surfacesMatch(a[0], b[0]) && surfacesMatch(a[1], b[1])) ||
    (surfacesMatch(a[0], b[1]) && surfacesMatch(a[1], b[0]))
  );
}

/** Order-independent KIND-only match of an adjacent-surface pair (moved/resized edge). */
function kindPairMatch(
  a: readonly [SurfaceSignature, SurfaceSignature],
  b: readonly [SurfaceSignature, SurfaceSignature],
): boolean {
  return (
    (a[0].kind === b[0].kind && a[1].kind === b[1].kind) ||
    (a[0].kind === b[1].kind && a[1].kind === b[0].kind)
  );
}

/** Order-independent alignment of an adjacent-normal pair (legacy edge). */
function normalPairAligned(a: readonly [V3, V3], b: readonly [V3, V3]): boolean {
  const s1 = dot(a[0], b[0]) + dot(a[1], b[1]);
  const s2 = dot(a[0], b[1]) + dot(a[1], b[0]);
  return Math.max(s1, s2) >= 2 * NORMAL_TOL;
}

/** The new face id whose ref is the same face as `old`, or null (face deleted).
 * Tier 3 = exact analytic surface; 2 = same surface kind; 1 = legacy normal.
 * Higher tier wins; ties broken by closest centroid. */
function bestFace(old: FaceRef, faces: SelectionRefs["faces"]): number | null {
  let bestId: number | null = null;
  let bestTier = 0;
  let bestDist = Infinity;
  for (const key of Object.keys(faces)) {
    const id = Number(key);
    const nRef = faces[id]!;
    let tier: number;
    if (old.surface && nRef.surface && surfacesMatch(old.surface, nRef.surface)) tier = 3;
    else if (old.surface && nRef.surface && old.surface.kind === nRef.surface.kind) tier = 2;
    else if (dot(old.normal, nRef.normal) >= NORMAL_TOL) tier = 1;
    else continue;
    const dist = old.centroid && nRef.centroid ? sqDist(old.centroid, nRef.centroid) : 0;
    if (tier > bestTier || (tier === bestTier && dist < bestDist)) {
      bestId = id;
      bestTier = tier;
      bestDist = dist;
    }
  }
  return bestId;
}

/** The new edge id whose ref is the same edge as `old`, or null (edge deleted). */
function bestEdge(old: EdgeRef, edges: SelectionRefs["edges"]): number | null {
  let bestId: number | null = null;
  let bestTier = 0;
  let bestDist = Infinity;
  for (const key of Object.keys(edges)) {
    const id = Number(key);
    const nRef = edges[id]!;
    let tier: number;
    if (old.faceSurfaces && nRef.faceSurfaces && surfacePairMatch(old.faceSurfaces, nRef.faceSurfaces)) tier = 3;
    else if (old.faceSurfaces && nRef.faceSurfaces && kindPairMatch(old.faceSurfaces, nRef.faceSurfaces)) tier = 2;
    else if (normalPairAligned(old.faceNormals, nRef.faceNormals)) tier = 1;
    else continue;
    const dist = old.midpoint && nRef.midpoint ? sqDist(old.midpoint, nRef.midpoint) : 0;
    if (tier > bestTier || (tier === bestTier && dist < bestDist)) {
      bestId = id;
      bestTier = tier;
      bestDist = dist;
    }
  }
  return bestId;
}

/** The new vertex id whose ref is the same corner as `old`, or null (deleted).
 * Primary key is position (a vertex has no analytic surface — §12.R12); optional
 * adjacent-edge midpoints break a positional tie the same way resolveVertexRef does. */
function bestVertex(old: VertexRef, vertices: Record<number, VertexRef>): number | null {
  let bestId: number | null = null;
  let bestPos = Infinity;
  let bestEdge = Infinity;
  const disamb = old.adjacentEdgeMidpoints;
  for (const key of Object.keys(vertices)) {
    const id = Number(key);
    const nRef = vertices[id]!;
    const pos = sqDist(old.position, nRef.position);
    if (pos > VERTEX_CAP_SQ) continue;
    let edgeScore = 0;
    if (disamb && disamb.length > 0 && nRef.adjacentEdgeMidpoints) {
      // Summed nearest-neighbour sq-dist (order-independent partial set).
      for (const r of disamb) {
        let nearest = Infinity;
        for (const c of nRef.adjacentEdgeMidpoints) {
          const d = sqDist(c, r);
          if (d < nearest) nearest = d;
        }
        edgeScore += nearest;
      }
    }
    if (
      bestId === null ||
      pos < bestPos - 1e-14 ||
      (Math.abs(pos - bestPos) <= 1e-14 && edgeScore < bestEdge)
    ) {
      bestId = id;
      bestPos = pos;
      bestEdge = edgeScore;
    }
  }
  return bestId;
}

/**
 * Remap `picks` from the outgoing `oldRefs` to the incoming `newRefs`.
 *
 * Face/edge/vertex picks are re-resolved by their stored analytic / positional
 * ref (dropping any that no longer resolve). A body pick is always id 0 and
 * passes through unchanged.
 */
export function remapPicks(picks: Pick[], oldRefs: SelectionRefs, newRefs: SelectionRefs): Pick[] {
  const out: Pick[] = [];
  for (const p of picks) {
    if (p.kind === "face") {
      const old = oldRefs.faces[p.id];
      if (!old) continue; // no stored ref to validate against → drop rather than guess
      const id = bestFace(old, newRefs.faces);
      if (id != null) out.push({ kind: "face", id });
    } else if (p.kind === "edge") {
      const old = oldRefs.edges[p.id];
      if (!old) continue;
      const id = bestEdge(old, newRefs.edges);
      if (id != null) out.push({ kind: "edge", id });
    } else if (p.kind === "vertex") {
      const old = oldRefs.vertices?.[p.id];
      if (!old) continue; // no stored VertexRef → drop rather than keep a stale id
      const id = bestVertex(old, newRefs.vertices ?? {});
      if (id != null) out.push({ kind: "vertex", id });
    } else {
      // body (always id 0): keep as-is.
      out.push(p);
    }
  }
  return out;
}

/** Whether two pick lists are identical (same kinds+ids in order) — lets the
 * caller skip a store write when nothing changed. */
export function samePickList(a: Pick[], b: Pick[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.kind === b[i]!.kind && p.id === b[i]!.id);
}
