import { describe, expect, it } from "vitest";
import type { MeshBody } from "./meshBody.js";
import {
  cloneMeshSelection,
  completeMeshFacePicks,
  decodeMeshPick,
  encodeMeshPick,
  meshFaces,
  meshSegments,
  transformMeshSelection,
  translateMeshSelection,
} from "./editMesh.js";

function body(): MeshBody {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("mesh edit helpers", () => {
  it("encodes mesh picks without collisions across bodies", () => {
    const a = encodeMeshPick(0, 7);
    const b = encodeMeshPick(2, 7);
    expect(a).not.toBe(b);
    expect(decodeMeshPick(b)).toEqual({ body: 2, local: 7 });
  });

  it("moves only the selected vertex", () => {
    const next = translateMeshSelection([body()], [{ kind: "vertex", id: encodeMeshPick(0, 1) }], [0, 0, 2]);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 0, 1, 0, 2, 0, 1, 0]);
  });

  it("moves both endpoints of a selected segment", () => {
    const next = translateMeshSelection([body()], [{ kind: "edge", id: encodeMeshPick(0, 0) }], [0, 0, 2]);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 2, 1, 0, 2, 0, 1, 0]);
  });

  it("maps triangle faces to their boundary vertices and segments", () => {
    expect(meshFaces(body())).toEqual([{ vertices: [0, 1, 2], edges: [0, 1, 2] }]);
  });

  it("promotes a face only when all boundary vertices and segments are selected", () => {
    const almost = [
      { kind: "vertex", id: encodeMeshPick(0, 0) },
      { kind: "vertex", id: encodeMeshPick(0, 1) },
      { kind: "vertex", id: encodeMeshPick(0, 2) },
      { kind: "edge", id: encodeMeshPick(0, 0) },
      { kind: "edge", id: encodeMeshPick(0, 1) },
    ];
    expect(completeMeshFacePicks([body()], almost)).toEqual([]);
    expect(completeMeshFacePicks([body()], [...almost, { kind: "edge", id: encodeMeshPick(0, 2) }])).toEqual([
      { kind: "face", id: encodeMeshPick(0, 0) },
    ]);
  });

  it("applies a full transform matrix to selected segment endpoints", () => {
    const rotate90AboutOrigin = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const next = transformMeshSelection([body()], [{ kind: "edge", id: encodeMeshPick(0, 1) }], rotate90AboutOrigin);
    expect(Array.from(next[0]!.positions)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
  });

  it("clones vertices as independent points and segments as standalone cloned segments", () => {
    const next = cloneMeshSelection(
      [body()],
      [
        { kind: "vertex", id: encodeMeshPick(0, 2) },
        { kind: "edge", id: encodeMeshPick(0, 0) },
      ],
      [0, 0, 1],
    );
    expect(next[0]!.positions.length / 3).toBe(6);
    expect(next[0]!.segments).toBeDefined();
    expect(meshSegments(next[0]!).length).toBe(4);
    expect(Array.from(next[0]!.positions.slice(9))).toEqual([0, 1, 1, 0, 0, 1, 1, 0, 1]);
  });

  it("clones a selected mesh body as independent indexed triangles", () => {
    const next = cloneMeshSelection([body()], [{ kind: "body", id: encodeMeshPick(0, 0) }], [0, 0, 1]);
    expect(next[0]!.positions.length / 3).toBe(6);
    expect(Array.from(next[0]!.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Array.from(next[0]!.positions.slice(9))).toEqual([0, 0, 1, 1, 0, 1, 0, 1, 1]);
  });
});
