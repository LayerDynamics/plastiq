// Selection highlighting (SPEC-5 FR-8/FR-14): show hover + selected state by
// swapping a face group's material slot (base→hover→selected) — no
// re-tessellation, the whole point of the per-face-group build. Edges swap to a
// shared hover/selected line material; vertices write their per-point colour.
//
// Pure functions over a BuiltPart + the current picks, so they are unit-tested
// without a WebGL context.

import * as THREE from "three";
import type { Pick } from "../store/types.js";
import type { BuiltPart } from "./buildMesh.js";
import { ENTITY_COLOR, FACE_MATERIAL } from "./buildMesh.js";

/** State of one entity given the current picks + hover. */
function slotFor(
  id: number,
  selected: Set<number>,
  hovered: number | null,
): keyof typeof FACE_MATERIAL {
  if (selected.has(id)) return "selected";
  if (id === hovered) return "hover";
  return "base";
}

function idSets(
  picks: readonly Pick[],
  hover: Pick | null,
  kind: Pick["kind"],
): { selected: Set<number>; hovered: number | null } {
  const selected = new Set<number>();
  for (const p of picks) if (p.kind === kind) selected.add(p.id);
  const hovered = hover && hover.kind === kind ? hover.id : null;
  return { selected, hovered };
}

/**
 * Reapply face/edge/vertex highlight state for `part` from the current `picks`
 * and `hover`. Idempotent: every entity is set to base, hover, or selected.
 */
export function applyHighlight(part: BuiltPart, picks: readonly Pick[], hover: Pick | null): void {
  // --- faces: swap each group's material slot -------------------------------
  const face = idSets(picks, hover, "face");
  const faceIds = part.mesh.userData["faceIds"] as number[] | undefined;
  const groups = part.mesh.geometry.groups;
  if (faceIds) {
    // WebGLRenderer reads geometry.groups live each frame, so updating
    // materialIndex takes effect without an explicit dirty flag.
    for (let i = 0; i < groups.length; i++) {
      groups[i]!.materialIndex = FACE_MATERIAL[slotFor(faceIds[i]!, face.selected, face.hovered)];
    }
  }

  // --- edges: point each line at the base/hover/selected shared material ----
  const edge = idSets(picks, hover, "edge");
  for (const line of part.edges) {
    const id = line.userData["edgeId"] as number;
    line.material = part.edgeMaterials[FACE_MATERIAL[slotFor(id, edge.selected, edge.hovered)]]!;
  }

  // --- vertices: write per-point colour ------------------------------------
  if (part.vertexPoints) {
    const vtx = idSets(picks, hover, "vertex");
    const ids = part.vertexPoints.userData["vertexIds"] as number[];
    const attr = part.vertexPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let i = 0; i < ids.length; i++) {
      c.setHex(ENTITY_COLOR[slotFor(ids[i]!, vtx.selected, vtx.hovered)]);
      attr.setXYZ(i, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }
}

/** Reset every entity of `part` back to its base (unselected) appearance. */
export function clearHighlight(part: BuiltPart): void {
  applyHighlight(part, [], null);
}
