// SPEC-6 R3.2 — selector predicates (FR-13, FR-14).
//
// Resolve a named, geometry-relative selector (e.g. "top face", "all vertical edges")
// against a solid into concrete FaceRef[]/EdgeRef[] signatures. Because resolution
// runs against the FRESHLY tessellated solid on every rebuild, a predicate-selected
// dress-up tracks parameter changes that move/rescale geometry — where a captured
// index/ref would drift (FR-14). Resolution works over the same tagged tessellation
// the editor already uses, so the refs it returns are exactly what fillet/chamfer/
// shell/draft consume.

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import type { FaceRef, EdgeRef } from "../mesh/tagged.js";
import { tessellateTagged } from "../mesh/tessellate.js";

type V3 = [number, number, number];

export type Selector =
  | { kind: "allFaces" }
  | { kind: "allEdges" }
  | { kind: "topFace" }
  | { kind: "bottomFace" }
  | { kind: "largestPlanarFace" }
  | { kind: "faceByNormal"; normal: [number, number, number]; tol?: number }
  | { kind: "edgesParallelTo"; axis: [number, number, number]; tol?: number }
  | { kind: "verticalEdges"; tol?: number };

export interface SelectorResult {
  faces: FaceRef[];
  edges: EdgeRef[];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const at = (flat: ArrayLike<number>, i: number): V3 => [flat[i * 3]!, flat[i * 3 + 1]!, flat[i * 3 + 2]!];

const dotTol = (deg: number): number => Math.cos((deg * Math.PI) / 180);

/** Triangle-summed area (m²) of a face group. */
function faceArea(mesh: { vertices: number[]; indices: number[] }, g: { start: number; count: number }): number {
  let area = 0;
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = at(mesh.vertices, mesh.indices[k]!);
    const b = at(mesh.vertices, mesh.indices[k + 1]!);
    const c = at(mesh.vertices, mesh.indices[k + 2]!);
    area += 0.5 * len(cross(sub(b, a), sub(c, a)));
  }
  return area;
}

/** Is a face group planar (all triangle normals align with the face normal)? */
function isPlanar(mesh: { vertices: number[]; indices: number[] }, g: { start: number; count: number; normal: V3 }): boolean {
  const n = unit(g.normal);
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = at(mesh.vertices, mesh.indices[k]!);
    const b = at(mesh.vertices, mesh.indices[k + 1]!);
    const c = at(mesh.vertices, mesh.indices[k + 2]!);
    if (dot(unit(cross(sub(b, a), sub(c, a))), n) < dotTol(5)) return false;
  }
  return true;
}

/** Direction of a (straight) edge from its polyline endpoints, or null if degenerate. */
function edgeDir(positions: number[]): V3 | null {
  const n = Math.floor(positions.length / 3);
  if (n < 2) return null;
  const d = sub(at(positions, n - 1), at(positions, 0));
  return len(d) > 1e-9 ? unit(d) : null;
}

/**
 * Resolve a selector against `solid`. Face selectors populate `.faces`; edge
 * selectors populate `.edges`. Tie-breaks are deterministic (documented per case) so
 * the same selector always picks the same entity across rebuilds.
 */
export function resolveSelector(oc: Occt, solid: Solid, selector: Selector): SelectorResult {
  const mesh = tessellateTagged(oc, solid);
  const faceRef = (g: { normal: V3; centroid: V3 }): FaceRef => ({ normal: g.normal, centroid: g.centroid });
  const edgeRef = (e: { faceNormals: readonly [V3, V3]; midpoint: V3 }): EdgeRef => ({ faceNormals: e.faceNormals, midpoint: e.midpoint });
  const groups = mesh.faceGroups as ReadonlyArray<{ normal: V3; centroid: V3; start: number; count: number }>;
  const edges = mesh.edges as ReadonlyArray<{ faceNormals: readonly [V3, V3]; midpoint: V3; positions: number[] }>;
  const none: SelectorResult = { faces: [], edges: [] };

  switch (selector.kind) {
    case "allFaces":
      return { faces: groups.map(faceRef), edges: [] };

    case "allEdges":
      return { faces: [], edges: edges.map(edgeRef) };

    case "topFace":
    case "bottomFace": {
      // Most up-/down-facing face; tie-break by extreme centroid.z, then lowest index.
      const sign = selector.kind === "topFace" ? 1 : -1;
      let best = -1;
      let bestKey: [number, number] = [-Infinity, -Infinity];
      groups.forEach((g, i) => {
        const key: [number, number] = [sign * unit(g.normal)[2], sign * g.centroid[2]];
        if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
          best = i;
          bestKey = key;
        }
      });
      return best >= 0 ? { faces: [faceRef(groups[best]!)], edges: [] } : none;
    }

    case "largestPlanarFace": {
      let best = -1;
      let bestArea = -Infinity;
      groups.forEach((g, i) => {
        if (!isPlanar(mesh as { vertices: number[]; indices: number[] }, g)) return;
        const area = faceArea(mesh as { vertices: number[]; indices: number[] }, g);
        if (area > bestArea) {
          bestArea = area;
          best = i;
        }
      });
      return best >= 0 ? { faces: [faceRef(groups[best]!)], edges: [] } : none;
    }

    case "faceByNormal": {
      const target = unit(selector.normal as V3);
      const tol = dotTol(selector.tol ?? 5);
      return { faces: groups.filter((g) => dot(unit(g.normal), target) >= tol).map(faceRef), edges: [] };
    }

    case "edgesParallelTo":
    case "verticalEdges": {
      const axis = unit(selector.kind === "verticalEdges" ? [0, 0, 1] : (selector.axis as V3));
      const tol = dotTol(selector.tol ?? 5);
      const out: EdgeRef[] = [];
      for (const e of edges) {
        const d = edgeDir(e.positions);
        if (d && Math.abs(dot(d, axis)) >= tol) out.push(edgeRef(e));
      }
      return { faces: [], edges: out };
    }

    default:
      return none;
  }
}

/** Type guard for a value that looks like a Selector (validates AI-authored data). */
export function isSelector(v: unknown): v is Selector {
  if (typeof v !== "object" || v === null) return false;
  const kind = (v as { kind?: unknown }).kind;
  return (
    kind === "allFaces" ||
    kind === "allEdges" ||
    kind === "topFace" ||
    kind === "bottomFace" ||
    kind === "largestPlanarFace" ||
    kind === "faceByNormal" ||
    kind === "edgesParallelTo" ||
    kind === "verticalEdges"
  );
}
