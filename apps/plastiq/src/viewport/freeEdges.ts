// §14 free-edge UX helpers — filter transfer-mesh edges marked isFree so the
// patch/sew pickers only accept naked boundary edges (ShapeAnalysis_FreeBounds /
// tessellate isFree flags).

import type { EdgeRef } from "@plastiq/cad";
import type { TransferMesh } from "../worker/protocol.js";

/** Edge group indices on a TransferMesh that carry the free-edge flag. */
export function freeEdgeGroupIds(mesh: TransferMesh | null | undefined): number[] {
  if (!mesh?.edges?.length) return [];
  const ids: number[] = [];
  for (let i = 0; i < mesh.edges.length; i++) {
    if (mesh.edges[i]!.isFree) ids.push(i);
  }
  return ids;
}

/**
 * Build EdgeRefs for free edges from a transfer mesh + selectionRefs.edges map.
 * Only groups with `isFree: true` are included — the patch picker contract.
 */
export function freeEdgeRefs(
  mesh: TransferMesh | null | undefined,
  edgeRefs: Record<number, EdgeRef> | undefined,
): EdgeRef[] {
  if (!mesh || !edgeRefs) return [];
  const out: EdgeRef[] = [];
  for (const id of freeEdgeGroupIds(mesh)) {
    const ref = edgeRefs[id];
    if (ref) out.push(ref);
  }
  return out;
}

/** True when the mesh reports any free edges (open shell/face body). */
export function hasFreeEdges(mesh: TransferMesh | null | undefined): boolean {
  if ((mesh?.freeEdgeCount ?? 0) > 0) return true;
  return freeEdgeGroupIds(mesh).length > 0;
}
