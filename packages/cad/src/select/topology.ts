// M2 — clean-room B-rep traversal substrate: dihedral edge convexity, face adjacency, and
// tangent-face grouping, computed over the tagged tessellation (face groups + edges carrying their
// two adjacent-face normals/ids/centroids). Implemented from the standard dihedral test and
// connected-component growth — NOT from BRepNet's source (CC-BY-NC-SA). See docs/adr/0002.
//
// Pure functions over a TaggedMesh — deterministic (NFR-2), no OCCT handle needed. They power the
// `tangentFaces` / `filletChain` / `convexEdges` / `concaveEdges` selectors (select/predicates.ts)
// and the reconstruction feature-recognition (services/reconstruct mirrors the same rule).

import type { FaceGroup, TaggedEdge, TaggedMesh } from "../mesh/tagged.js";

export type Convexity = "convex" | "concave" | "smooth";

type V3 = readonly [number, number, number];

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): [number, number, number] => {
  const l = norm(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const at = (flat: ArrayLike<number>, i: number): [number, number, number] => [
  flat[i * 3]!,
  flat[i * 3 + 1]!,
  flat[i * 3 + 2]!,
];

/** Two faces meeting within this angle of flat (normals near-parallel) are a smooth/tangent (G1)
 * join — a fillet or blend, not a sharp edge. 5° matches the kernel's selection tolerances. */
const SMOOTH_DOT = Math.cos((5 * Math.PI) / 180);

/** The outward normal of the triangle in face `faceId` nearest the point `p` — a LOCAL surface
 * normal at that point. Triangle winding is already outward-corrected in the tessellation, so the
 * cross product points outward. Falls back to `null` if the face has no triangles. For a planar
 * face this equals the face normal; for a curved face it is the normal *at the edge*, which the
 * face-level average is not — essential for detecting tangent (smooth) joins on fillets. */
function localNormalAt(mesh: TaggedMesh, faceId: number, p: V3): [number, number, number] | null {
  const g = mesh.faceGroups[faceId];
  if (!g) return null;
  let best: [number, number, number] | null = null;
  let bestD = Infinity;
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = at(mesh.vertices, mesh.indices[k]!);
    const b = at(mesh.vertices, mesh.indices[k + 1]!);
    const c = at(mesh.vertices, mesh.indices[k + 2]!);
    const cen: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const d = dot(sub(cen, p), sub(cen, p));
    if (d < bestD) {
      bestD = d;
      best = unit(cross(sub(b, a), sub(c, a)));
    }
  }
  return best;
}

/**
 * Classify an edge as convex / concave / smooth from its two adjacent faces, using the LOCAL face
 * normals at the edge (the nearest-triangle normals) so curved fillet/blend faces are handled.
 *
 * - **smooth** when the faces are near-tangent at the edge (`na·nb ≥ cos 5°`) or it is a seam (one
 *   face both sides) — fillets and blends.
 * - **convex** when each face folds *away* from the other's interior (`na·(cb−m) < 0` and
 *   `nb·(ca−m) < 0`) — an exterior edge.
 * - **concave** otherwise — an interior (pocket/step) edge.
 *
 * Orientation-robust (uses the adjacent faces' centroids, not wire orientation) and deterministic.
 *
 * NOTE: smooth (tangent) detection on CURVED faces needs a curvature-resolving mesh — tessellate
 * with a fine angular deflection (≈0.1 rad), as `resolveSelector` does. The coarse render default
 * (0.5 rad) leaves a fillet's boundary-triangle normal too far from the true tangent.
 */
export function edgeConvexity(mesh: TaggedMesh, edge: TaggedEdge): Convexity {
  const [idA, idB] = edge.faceIds;
  if (idA === idB || idA < 0 || idB < 0) return "smooth"; // seam / missing data → treat as tangent
  const gA = mesh.faceGroups[idA];
  const gB = mesh.faceGroups[idB];
  if (!gA || !gB) return "smooth";
  const m = edge.midpoint;
  const na = localNormalAt(mesh, idA, m) ?? unit(edge.faceNormals[0]);
  const nb = localNormalAt(mesh, idB, m) ?? unit(edge.faceNormals[1]);
  if (dot(na, nb) >= SMOOTH_DOT) return "smooth"; // near-tangent at the edge → G1 join
  const foldsAway = dot(na, sub(gB.centroid, m)) < 0 && dot(nb, sub(gA.centroid, m)) < 0;
  return foldsAway ? "convex" : "concave";
}

/** Adjacency list: face id → its neighbours across shared edges, each tagged with the edge and the
 * edge's convexity. Every face group is a key (isolated faces map to an empty list). */
export function faceAdjacency(
  mesh: TaggedMesh,
): Map<number, Array<{ edge: TaggedEdge; neighbor: number; convexity: Convexity }>> {
  const adj = new Map<number, Array<{ edge: TaggedEdge; neighbor: number; convexity: Convexity }>>();
  for (const g of mesh.faceGroups) adj.set(g.faceId, []);
  for (const edge of mesh.edges) {
    const [a, b] = edge.faceIds;
    if (a === b || a < 0 || b < 0) continue;
    const convexity = edgeConvexity(mesh, edge);
    adj.get(a)?.push({ edge, neighbor: b, convexity });
    adj.get(b)?.push({ edge, neighbor: a, convexity });
  }
  return adj;
}

/** The connected set of faces reachable from `seedFaceId` across only SMOOTH (tangent) edges — the
 * tangent-continuous patch the seed belongs to. A box seed (all sharp edges) returns just itself. */
export function growTangentFaces(mesh: TaggedMesh, seedFaceId: number): Set<number> {
  const adj = faceAdjacency(mesh);
  const seen = new Set<number>([seedFaceId]);
  const stack = [seedFaceId];
  while (stack.length) {
    const f = stack.pop()!;
    for (const { neighbor, convexity } of adj.get(f) ?? []) {
      if (convexity === "smooth" && !seen.has(neighbor)) {
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }
  }
  return seen;
}

/** Is a face group curved (non-planar)? True when its triangle normals deviate from the group's
 * outward normal beyond the 5° smooth tolerance — i.e. the face is not a single flat plane. */
export function faceIsCurved(mesh: TaggedMesh, g: FaceGroup): boolean {
  const n = unit(g.normal);
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = at(mesh.vertices, mesh.indices[k]!);
    const b = at(mesh.vertices, mesh.indices[k + 1]!);
    const c = at(mesh.vertices, mesh.indices[k + 2]!);
    const tn = unit(cross(sub(b, a), sub(c, a)));
    if (dot(tn, n) < SMOOTH_DOT) return true;
  }
  return false;
}

/** The fillet/blend faces: curved faces that join at least one neighbour tangentially (a smooth
 * edge). These are the rounded transitions a "select fillet chain" wants. */
export function filletFaces(mesh: TaggedMesh): Set<number> {
  const adj = faceAdjacency(mesh);
  const out = new Set<number>();
  for (const g of mesh.faceGroups) {
    if (!faceIsCurved(mesh, g)) continue;
    if ((adj.get(g.faceId) ?? []).some((n) => n.convexity === "smooth")) out.add(g.faceId);
  }
  return out;
}
