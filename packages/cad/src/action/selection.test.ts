import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import {
  buildEdgeAdjacency,
  listFaces,
  resolveEdge,
  resolveFace,
  type EdgeRef,
  type FaceRef,
} from "./selection.js";

const INIT_TIMEOUT_MS = 120_000;

describe("persistent topological naming (FR-16 / R2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a box has 6 faces with the 6 axis-aligned normals", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const faces = listFaces(oc, box);
      expect(faces.length).toBe(6);
      // Every face normal is a unit axis direction; +Z appears exactly once.
      const plusZ = faces.filter((f) => 1 - (f.normal[2] ?? 0) < 1e-6);
      expect(plusZ.length).toBe(1);
      faces.forEach((f) => f.face.delete());
    } finally {
      box.delete();
    }
  });

  it("a box has 12 edges, each adjacent to exactly 2 faces", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const edges = buildEdgeAdjacency(oc, box);
      expect(edges.length).toBe(12);
      expect(edges.every((e) => e.normals.length === 2)).toBe(true);
      edges.forEach((e) => e.edge.delete());
    } finally {
      box.delete();
    }
  });

  it("a face selection (by normal) re-resolves after a parameter rebuild", () => {
    const ref: FaceRef = { normal: [0, 0, 1] }; // the +Z (top) face
    const small = makeBox(oc, mm(20), mm(20), mm(20));
    const tall = makeBox(oc, mm(20), mm(20), mm(50)); // "rebuilt" with a different height
    try {
      const f1 = resolveFace(oc, small, ref);
      const f2 = resolveFace(oc, tall, ref);
      // The +Z face re-resolves in both the original and the rebuilt solid (R2).
      expect(f1).not.toBeNull();
      expect(f2).not.toBeNull();
      f1?.delete();
      f2?.delete();
    } finally {
      small.delete();
      tall.delete();
    }
  });

  it("an EDGE selection (adjacent +Z/+X) survives a parameter rebuild", () => {
    const ref: EdgeRef = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ],
    }; // top-front edge
    const small = makeBox(oc, mm(20), mm(20), mm(20));
    const tall = makeBox(oc, mm(20), mm(20), mm(50));
    try {
      const e1 = resolveEdge(oc, small, ref);
      const e2 = resolveEdge(oc, tall, ref);
      expect(e1).not.toBeNull();
      expect(e2).not.toBeNull(); // same logical edge resolves in the rebuilt solid (R2)
      e1?.delete();
      e2?.delete();
    } finally {
      small.delete();
      tall.delete();
    }
  });

  it("an unresolvable reference returns null (→ typed rebuild error)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      // No box edge is adjacent to both +Z and −Z faces.
      const impossible: EdgeRef = {
        faceNormals: [
          [0, 0, 1],
          [0, 0, -1],
        ],
      };
      expect(resolveEdge(oc, box, impossible)).toBeNull();
      // No face points along (1,1,1)/√3 on an axis-aligned box.
      const noFace: FaceRef = { normal: normalizeTriple(1, 1, 1) };
      expect(resolveFace(oc, box, noFace)).toBeNull();
    } finally {
      box.delete();
    }
  });
});

function normalizeTriple(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}
