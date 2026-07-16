import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { encodeMeshPick } from "../mesh/editMesh.js";
import type { MeshBody } from "../mesh/meshBody.js";
import { buildMeshBody, ENTITY_COLOR, FACE_MATERIAL } from "./buildMesh.js";
import { applyMeshHighlight } from "./meshHighlight.js";

function body(): MeshBody {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

function pointColorHex(built: ReturnType<typeof buildMeshBody>, index: number): number {
  const attr = built.vertexPoints.geometry.getAttribute("color") as THREE.BufferAttribute;
  return new THREE.Color(attr.getX(index), attr.getY(index), attr.getZ(index)).getHex();
}

function selectedFaceHex(built: ReturnType<typeof buildMeshBody>): number {
  return ((built.mesh.material as THREE.MeshStandardMaterial[])[FACE_MATERIAL.selected]!).color.getHex();
}

describe("applyMeshHighlight", () => {
  it("hovers a mesh face with the same hover material slot as CAD faces", () => {
    const built = buildMeshBody(body());
    applyMeshHighlight([built], [], { kind: "face", id: encodeMeshPick(0, 0) });
    expect(built.mesh.geometry.groups[0]!.materialIndex).toBe(FACE_MATERIAL.hover);
  });

  it("hovers a mesh edge/vector by swapping to the hover line material", () => {
    const built = buildMeshBody(body());
    applyMeshHighlight([built], [], { kind: "edge", id: encodeMeshPick(0, 1) });
    expect(built.edges[1]!.material).toBe(built.edgeMaterials[FACE_MATERIAL.hover]);
    expect(built.edges[0]!.material).toBe(built.edgeMaterials[FACE_MATERIAL.base]);
  });

  it("hovers a mesh point by writing the hover point colour", () => {
    const built = buildMeshBody(body());
    applyMeshHighlight([built], [], { kind: "vertex", id: encodeMeshPick(0, 2) });
    expect(pointColorHex(built, 2)).toBe(ENTITY_COLOR.hover);
    expect(pointColorHex(built, 0)).toBe(ENTITY_COLOR.base);
  });

  it("selected mesh points stay selected even when hovered", () => {
    const built = buildMeshBody(body());
    const pick = { kind: "vertex" as const, id: encodeMeshPick(0, 2) };
    applyMeshHighlight([built], [pick], pick);
    expect(pointColorHex(built, 2)).toBe(selectedFaceHex(built));
  });

  it("selected mesh edges/vectors use the same orange as selected faces", () => {
    const built = buildMeshBody(body());
    const pick = { kind: "edge" as const, id: encodeMeshPick(0, 1) };
    applyMeshHighlight([built], [pick], null);
    expect(built.edges[1]!.material).toBe(built.edgeMaterials[FACE_MATERIAL.selected]);
    expect((built.edges[1]!.material as THREE.LineBasicMaterial).color.getHex()).toBe(selectedFaceHex(built));
  });
});
