import * as THREE from "three";
import type { Pick } from "../store/types.js";
import { decodeMeshPick } from "../mesh/editMesh.js";
import type { BuiltMeshBody } from "./buildMesh.js";
import { ENTITY_COLOR, FACE_MATERIAL } from "./buildMesh.js";

const pickKey = (pick: Pick): string => `${pick.kind}:${pick.id}`;

function setPointColor(points: THREE.Points, index: number, color: THREE.Color): void {
  const attr = points.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!attr || index < 0 || index >= attr.count) return;
  attr.setXYZ(index, color.r, color.g, color.b);
  attr.needsUpdate = true;
}

export function applyMeshHighlight(
  builtBodies: readonly BuiltMeshBody[],
  picks: readonly Pick[],
  hover: Pick | null,
): void {
  const selected = new Set(picks.map(pickKey));
  const hovered = hover ? pickKey(hover) : null;
  const base = new THREE.Color(ENTITY_COLOR.base);
  const selectedColor = new THREE.Color(ENTITY_COLOR.selected);
  const hoverColor = new THREE.Color(ENTITY_COLOR.hover);

  for (const built of builtBodies) {
    const baseMaterial = built.edgeMaterials[FACE_MATERIAL.base];
    if (baseMaterial) for (const edge of built.edges) edge.material = baseMaterial;
    for (const group of built.mesh.geometry.groups) group.materialIndex = FACE_MATERIAL.base;
    const pos = built.vertexPoints.geometry.getAttribute("position");
    for (let i = 0; i < pos.count; i++) setPointColor(built.vertexPoints, i, base);
  }

  for (const pick of [...picks, ...(hover ? [hover] : [])]) {
    const { body, local } = decodeMeshPick(pick.id);
    const built = builtBodies[body];
    if (!built) continue;
    const key = pickKey(pick);
    const isSelected = selected.has(key);
    const isHovered = hovered === key;
    const color = isSelected ? selectedColor : isHovered ? hoverColor : base;
    if (pick.kind === "face") {
      const group = built.mesh.geometry.groups[local];
      if (group) group.materialIndex = isSelected ? FACE_MATERIAL.selected : FACE_MATERIAL.hover;
    }
    if (pick.kind === "edge") {
      const edge = built.edges[local];
      const material = built.edgeMaterials[isSelected ? FACE_MATERIAL.selected : FACE_MATERIAL.hover];
      if (edge && material) edge.material = material;
    }
    if (pick.kind === "vertex") setPointColor(built.vertexPoints, local, color);
  }
}
