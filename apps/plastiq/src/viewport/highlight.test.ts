import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { Pick } from "../store/types.js";
import type { TransferMesh } from "../worker/protocol.js";
import { buildPart, ENTITY_COLOR, FACE_MATERIAL } from "./buildMesh.js";
import { applyHighlight, clearHighlight } from "./highlight.js";

// Both fixture faces lie in the z=0 plane, so they share its analytic signature
// (§2.1) — the identity a FaceGroup carries alongside its averaged normal.
const PLANE_Z0 = { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0] } as const;

function quad(): TransferMesh {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 7, start: 0, count: 3, normal: [0, 0, 1], centroid: [0.667, 0.333, 0], surface: PLANE_Z0 },
      { faceId: 9, start: 3, count: 3, normal: [0, 0, 1], centroid: [0.333, 0.667, 0], surface: PLANE_Z0 },
    ],
    edges: [
      {
        edgeId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        faceNormals: [
          [0, 0, 1],
          [0, -1, 0],
        ],
        faceSurfaces: [PLANE_Z0, { kind: "plane", normal: [0, -1, 0], origin: [0, 0, 0] }],
        midpoint: [0.5, 0, 0],
      },
      {
        edgeId: 5,
        positions: new Float32Array([1, 0, 0, 1, 1, 0]),
        faceNormals: [
          [0, 0, 1],
          [1, 0, 0],
        ],
        faceSurfaces: [PLANE_Z0, { kind: "plane", normal: [1, 0, 0], origin: [0, 0, 0] }],
        midpoint: [1, 0.5, 0],
      },
    ],
    vertexIds: [11, 12, 13],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
  };
}

function vtxColorHex(part: ReturnType<typeof buildPart>, i: number): number {
  const attr = part.vertexPoints!.geometry.getAttribute("color") as THREE.BufferAttribute;
  return new THREE.Color(attr.getX(i), attr.getY(i), attr.getZ(i)).getHex();
}

function selectedFaceHex(part: ReturnType<typeof buildPart>): number {
  return ((part.mesh.material as THREE.MeshStandardMaterial[])[FACE_MATERIAL.selected]!).color.getHex();
}

describe("applyHighlight — base/hover/selected per entity", () => {
  it("selecting a face flips only that group's material slot", () => {
    const part = buildPart(quad());
    const picks: Pick[] = [{ kind: "face", id: 9 }];
    applyHighlight(part, picks, null);
    const groups = part.mesh.geometry.groups;
    const faceIds = part.mesh.userData["faceIds"] as number[];
    expect(groups[faceIds.indexOf(9)]!.materialIndex).toBe(FACE_MATERIAL.selected);
    expect(groups[faceIds.indexOf(7)]!.materialIndex).toBe(FACE_MATERIAL.base);
  });

  it("hovering a face shows hover unless it is also selected", () => {
    const part = buildPart(quad());
    applyHighlight(part, [{ kind: "face", id: 9 }], { kind: "face", id: 7 });
    const groups = part.mesh.geometry.groups;
    const faceIds = part.mesh.userData["faceIds"] as number[];
    expect(groups[faceIds.indexOf(7)]!.materialIndex).toBe(FACE_MATERIAL.hover);
    expect(groups[faceIds.indexOf(9)]!.materialIndex).toBe(FACE_MATERIAL.selected);
  });

  it("selecting an edge points that line at the selected material", () => {
    const part = buildPart(quad());
    applyHighlight(part, [{ kind: "edge", id: 5 }], null);
    const sel = part.edges.find((l) => l.userData["edgeId"] === 5)!;
    const base = part.edges.find((l) => l.userData["edgeId"] === 4)!;
    expect(sel.material).toBe(part.edgeMaterials[FACE_MATERIAL.selected]);
    expect((sel.material as THREE.LineBasicMaterial).color.getHex()).toBe(selectedFaceHex(part));
    expect(base.material).toBe(part.edgeMaterials[FACE_MATERIAL.base]);
  });

  it("hovering an edge points that line at the hover material", () => {
    const part = buildPart(quad());
    applyHighlight(part, [], { kind: "edge", id: 5 });
    const hovered = part.edges.find((l) => l.userData["edgeId"] === 5)!;
    const base = part.edges.find((l) => l.userData["edgeId"] === 4)!;
    expect(hovered.material).toBe(part.edgeMaterials[FACE_MATERIAL.hover]);
    expect(base.material).toBe(part.edgeMaterials[FACE_MATERIAL.base]);
  });

  it("selecting a vertex writes only that corner's colour", () => {
    const part = buildPart(quad());
    applyHighlight(part, [{ kind: "vertex", id: 13 }], null);
    expect(vtxColorHex(part, 2)).toBe(selectedFaceHex(part)); // vertexIds[2] === 13
    expect(vtxColorHex(part, 0)).toBe(ENTITY_COLOR.base);
  });

  it("hovering a vertex writes only that corner's hover colour", () => {
    const part = buildPart(quad());
    applyHighlight(part, [], { kind: "vertex", id: 13 });
    expect(vtxColorHex(part, 2)).toBe(ENTITY_COLOR.hover); // vertexIds[2] === 13
    expect(vtxColorHex(part, 0)).toBe(ENTITY_COLOR.base);
  });

  it("clearHighlight resets every entity to base", () => {
    const part = buildPart(quad());
    applyHighlight(
      part,
      [
        { kind: "face", id: 9 },
        { kind: "edge", id: 5 },
      ],
      { kind: "vertex", id: 11 },
    );
    clearHighlight(part);
    expect(part.mesh.geometry.groups.every((g) => g.materialIndex === FACE_MATERIAL.base)).toBe(
      true,
    );
    expect(part.edges.every((l) => l.material === part.edgeMaterials[FACE_MATERIAL.base])).toBe(
      true,
    );
    expect(vtxColorHex(part, 0)).toBe(ENTITY_COLOR.base);
  });
});
