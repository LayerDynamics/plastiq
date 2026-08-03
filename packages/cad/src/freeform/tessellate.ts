// @plastiq/cad — freeform pillar: grid tessellation of a NURBS surface into a
// renderable triangle mesh with per-vertex normals.
//
// The mesh is watertight in parameter space: the (resU+1) × (resV+1) grid nodes
// are the ONLY vertices, and every quad cell is split into two triangles sharing
// those exact node indices, so adjacent cells share edges with no duplicated /
// mismatched vertices — no cracks. This is the interactive-loop tessellator the
// control-net editor re-runs on every drag (FablesFindings.md §15 Lane A(a):
// "control-point drags re-tessellate at 60 fps without a worker round-trip").

import { evaluateWithNormal } from "./deBoor.js";
import { domain, type NurbsSurface } from "./nurbsSurface.js";

export interface TessellateOptions {
  /** Number of quad cells along u (≥ 1). resU+1 vertices span the u domain. */
  resU: number;
  /** Number of quad cells along v (≥ 1). resV+1 vertices span the v domain. */
  resV: number;
}

export interface TessellatedSurface {
  /** Flat xyz triples, (resU+1)*(resV+1) vertices. */
  positions: Float32Array;
  /** Triangle indices into `positions` (as vertices), 6 per quad cell. */
  indices: Uint32Array;
  /** Flat xyz unit-normal triples, parallel to `positions`. */
  normals: Float32Array;
}

/**
 * Tessellate `surf` over its parameter domain into a triangle grid.
 *
 * Vertex `(i, j)` (u-step i, v-step j) has linear index `i * (resV+1) + j`.
 */
export function tessellate(
  surf: NurbsSurface,
  opts: TessellateOptions,
): TessellatedSurface {
  const resU = Math.max(1, Math.floor(opts.resU));
  const resV = Math.max(1, Math.floor(opts.resV));
  const { u0, u1, v0, v1 } = domain(surf);

  const nu = resU + 1;
  const nv = resV + 1;
  const vertexCount = nu * nv;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);

  for (let i = 0; i < nu; i++) {
    // Clamp to the closed domain so the boundary rows land exactly on the edge.
    const u = clamp(u0 + ((u1 - u0) * i) / resU, u0, u1);
    for (let j = 0; j < nv; j++) {
      const v = clamp(v0 + ((v1 - v0) * j) / resV, v0, v1);
      const { position, normal } = evaluateWithNormal(surf, u, v);
      const base = (i * nv + j) * 3;
      positions[base] = position[0];
      positions[base + 1] = position[1];
      positions[base + 2] = position[2];
      normals[base] = normal[0];
      normals[base + 1] = normal[1];
      normals[base + 2] = normal[2];
    }
  }

  // Two triangles per quad cell; wound so the face normal follows +u × +v.
  const indices = new Uint32Array(resU * resV * 6);
  let k = 0;
  for (let i = 0; i < resU; i++) {
    for (let j = 0; j < resV; j++) {
      const a = i * nv + j;
      const b = (i + 1) * nv + j;
      const c = (i + 1) * nv + (j + 1);
      const d = i * nv + (j + 1);
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  return { positions, indices, normals };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
