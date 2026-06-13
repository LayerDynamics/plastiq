import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { TransferMesh } from "../worker/protocol.js";
import { buildPart } from "./buildMesh.js";
import { boxSelect, faceIdAt, ndcRect, Picker } from "./pick.js";

// A unit quad in the z=0 plane (two triangles), split into two B-rep faces, with
// four corner vertices and one edge — enough to exercise every pick mode.
function quad(): TransferMesh {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 7, start: 0, count: 3, normal: [0, 0, 1], centroid: [0.667, 0.333, 0] },
      { faceId: 9, start: 3, count: 3, normal: [0, 0, 1], centroid: [0.333, 0.667, 0] },
    ],
    edges: [
      {
        edgeId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        faceNormals: [
          [0, 0, 1],
          [0, -1, 0],
        ],
        midpoint: [0.5, 0, 0],
      },
    ],
    vertexIds: [11, 12, 13, 14],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  };
}

describe("faceIdAt — triangle index → B-rep faceId (the keystone mapping)", () => {
  it("maps each triangle to the group whose [start,count) contains it", () => {
    const part = buildPart(quad());
    expect(faceIdAt(part, 0)).toBe(7); // triangle 0 → offset 0 → group {0,3}
    expect(faceIdAt(part, 1)).toBe(9); // triangle 1 → offset 3 → group {3,3}
  });

  it("returns null for an out-of-range triangle index", () => {
    const part = buildPart(quad());
    expect(faceIdAt(part, 99)).toBeNull();
  });
});

describe("Picker — raycast resolves the front-most entity per mode", () => {
  // Camera looking straight down -Z at the quad centre; NDC (0,0) → centre ray.
  function camera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    cam.position.set(0.5, 0.5, 5);
    cam.lookAt(0.5, 0.5, 0);
    cam.updateMatrixWorld(true);
    return cam;
  }
  const centre = new THREE.Vector2(0, 0);

  it("face mode resolves the triangle under the ray to its faceId", () => {
    const part = buildPart(quad());
    const pick = new Picker().pick(part, centre, camera(), "face");
    // The centre ray crosses the diagonal; it hits one of the two faces.
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("face");
    expect([7, 9]).toContain(pick!.id);
  });

  it("body mode resolves a whole-part pick from any face hit", () => {
    const part = buildPart(quad());
    const pick = new Picker().pick(part, centre, camera(), "body");
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("body");
  });

  it("vertex mode picks the nearest corner by its vertexId", () => {
    const part = buildPart(quad());
    // Aim at the (1,1) corner → its NDC under this camera.
    const cam = camera();
    const ndc = new THREE.Vector3(1, 1, 0).project(cam);
    const pick = new Picker({ line: 0.001, point: 0.2 }).pick(
      part,
      new THREE.Vector2(ndc.x, ndc.y),
      cam,
      "vertex",
    );
    expect(pick).not.toBeNull();
    expect(pick!.kind).toBe("vertex");
    expect(pick!.id).toBe(13); // vertexIds[2] sits at (1,1,0)
  });

  it("returns null on empty space", () => {
    const part = buildPart(quad());
    const pick = new Picker().pick(part, new THREE.Vector2(0.99, 0.99), camera(), "face");
    expect(pick).toBeNull();
  });
});

describe("boxSelect — rubber-band rectangle containment (FR-10)", () => {
  const cands = [
    { id: 1, x: -0.5, y: -0.5 },
    { id: 2, x: 0.0, y: 0.0 },
    { id: 3, x: 0.4, y: 0.3 },
    { id: 4, x: 0.9, y: 0.9 }, // outside a centred rect
  ];

  it("selects only candidates whose point is inside the rect", () => {
    const rect = ndcRect({ x: -0.6, y: -0.6 }, { x: 0.5, y: 0.5 });
    expect(boxSelect(rect, cands).sort()).toEqual([1, 2, 3]);
  });

  it("ndcRect normalises corners in any drag direction", () => {
    const a = ndcRect({ x: 0.5, y: 0.5 }, { x: -0.6, y: -0.6 });
    const b = ndcRect({ x: -0.6, y: 0.5 }, { x: 0.5, y: -0.6 });
    expect(a).toEqual(b);
  });

  it("an empty rect selects nothing", () => {
    expect(boxSelect(ndcRect({ x: 0.95, y: 0.95 }, { x: 0.99, y: 0.99 }), cands)).toEqual([]);
  });
});
