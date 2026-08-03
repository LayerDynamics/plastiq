// §14 free-edge UX — pure filters over TransferMesh isFree flags.

import { describe, expect, it } from "vitest";
import type { EdgeRef } from "@plastiq/cad";
import type { TransferMesh } from "../worker/protocol.js";
import { freeEdgeGroupIds, freeEdgeRefs, hasFreeEdges } from "./freeEdges.js";

const plane = { kind: "plane" as const, origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };

function edge(
  partial: Partial<TransferMesh["edges"][number]> & { isFree?: boolean },
): TransferMesh["edges"][number] {
  return {
    edgeId: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0]),
    faceNormals: [
      [0, 0, 1],
      [0, 0, 1],
    ],
    faceSurfaces: [plane, plane],
    midpoint: [0.5, 0, 0],
    ...partial,
  };
}

function mesh(partial: Partial<TransferMesh> & { edges: TransferMesh["edges"] }): TransferMesh {
  return {
    vertices: new Float32Array(0),
    indices: new Uint32Array(0),
    faceGroups: [],
    vertexIds: [],
    vertexPositions: new Float32Array(0),
    ...partial,
  };
}

describe("freeEdges (§14 patch picker)", () => {
  it("lists only isFree edge group indices", () => {
    const m = mesh({
      edges: [edge({ isFree: true, edgeId: 0 }), edge({ edgeId: 1 }), edge({ isFree: true, edgeId: 2 })],
      freeEdgeCount: 2,
      bodyKind: "shell",
    });
    expect(freeEdgeGroupIds(m)).toEqual([0, 2]);
    expect(hasFreeEdges(m)).toBe(true);
  });

  it("maps free groups to EdgeRefs for patch data.edges", () => {
    const m = mesh({
      edges: [edge({ isFree: true, edgeId: 0 }), edge({ edgeId: 1 })],
      freeEdgeCount: 1,
    });
    const refs: Record<number, EdgeRef> = {
      0: {
        faceNormals: [
          [0, 0, 1],
          [0, 0, 1],
        ],
        midpoint: [0, 0, 0],
        faceSurfaces: [plane, plane],
      },
      1: {
        faceNormals: [
          [0, 1, 0],
          [0, 1, 0],
        ],
        midpoint: [1, 0, 0],
        faceSurfaces: [plane, plane],
      },
    };
    const free = freeEdgeRefs(m, refs);
    expect(free).toHaveLength(1);
    expect(free[0]).toBe(refs[0]);
  });

  it("hasFreeEdges is false for closed solids with no free flags", () => {
    const m = mesh({
      edges: [edge({ edgeId: 0 }), edge({ edgeId: 1 })],
      freeEdgeCount: 0,
      bodyKind: "solid",
    });
    expect(hasFreeEdges(m)).toBe(false);
    expect(freeEdgeGroupIds(m)).toEqual([]);
  });
});
