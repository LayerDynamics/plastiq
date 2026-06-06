import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import type { TransferMesh } from "../worker/protocol.js";
import { buildPart, FACE_MATERIAL } from "./buildMesh.js";

// A minimal tagged mesh: two triangles split across two faces + two edges.
function sampleMesh(): TransferMesh {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 1, start: 0, count: 3, normal: [0, 0, 1] },
      { faceId: 2, start: 3, count: 3, normal: [0, 0, 1] },
    ],
    edges: [
      {
        edgeId: 1,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        faceNormals: [
          [0, 0, 1],
          [0, -1, 0],
        ],
      },
      {
        edgeId: 2,
        positions: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 0]), // 2-segment polyline
        faceNormals: [
          [0, 0, 1],
          [1, 0, 0],
        ],
      },
    ],
    vertexIds: [10, 20, 30],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
  };
}

describe("buildPart — tagged mesh → three.js (SPEC-5 M0.5)", () => {
  it("builds a mesh with one render group per B-rep face", () => {
    const part = buildPart(sampleMesh());
    const geom = part.mesh.geometry;
    expect(geom.groups).toHaveLength(2);
    expect(geom.groups[0]).toMatchObject({ start: 0, count: 3, materialIndex: FACE_MATERIAL.base });
    expect(geom.groups[1]).toMatchObject({ start: 3, count: 3 });
    // groupIndex ↔ faceId map for pick resolution (M1).
    expect(part.mesh.userData["faceIds"]).toEqual([1, 2]);
    // base/hover/selected material slots.
    expect(Array.isArray(part.mesh.material)).toBe(true);
    expect((part.mesh.material as THREE.Material[]).length).toBe(3);
  });

  it("builds one Line per edge, tagged with its edgeId, as segment pairs", () => {
    const part = buildPart(sampleMesh());
    expect(part.edges).toHaveLength(2);
    expect(part.edges.map((l) => l.userData["edgeId"])).toEqual([1, 2]);
    // edge 1: a single segment → 2 points (6 floats).
    const p0 = part.edges[0]!.geometry.getAttribute("position");
    expect(p0.count).toBe(2);
    // edge 2: a 2-segment polyline → 4 segment endpoints (2 segments × 2).
    const p1 = part.edges[1]!.geometry.getAttribute("position");
    expect(p1.count).toBe(4);
  });

  it("builds a Points cloud of B-rep corners tagged with their vertexIds", () => {
    const part = buildPart(sampleMesh());
    expect(part.vertexPoints).not.toBeNull();
    expect(part.vertexPoints!.userData["vertexIds"]).toEqual([10, 20, 30]);
    expect(part.vertexPoints!.geometry.getAttribute("position").count).toBe(3);
  });

  it("the part group contains the solid mesh + the edge lines + the corner points", () => {
    const part = buildPart(sampleMesh());
    expect(part.group.children).toContain(part.mesh);
    expect(part.group.children).toContain(part.vertexPoints);
    expect(part.group.children.length).toBe(1 + part.edges.length + 1);
    // Vertex normals were computed (lighting needs them).
    expect(part.mesh.geometry.getAttribute("normal")).toBeDefined();
  });
});
