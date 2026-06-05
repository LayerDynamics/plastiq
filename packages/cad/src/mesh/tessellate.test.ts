// R3 — tagged tessellation + persistent-ref resolution against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "./tessellate.js";
import { resolveEdgeRef, resolveFaceRef } from "./resolve.js";
import { faceNormal } from "./normals.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("tessellateTagged", () => {
  it("partitions a box into 6 faces, 12 edges, 8 vertices", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    expect(mesh.faceGroups).toHaveLength(6);
    expect(mesh.edges).toHaveLength(12);
    expect(mesh.vertexPoints).toHaveLength(8);
    box.delete();
  });

  it("emits the 6 outward axis normals as face signatures", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    const rounded = mesh.faceGroups
      .map((g) => g.normal.map((x) => Math.round(x)).join(","))
      .sort();
    expect(rounded).toEqual(["-1,0,0", "0,-1,0", "0,0,-1", "0,0,1", "0,1,0", "1,0,0"]);
    box.delete();
  });

  it("produces a valid, in-range, non-empty index buffer with covering groups", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const mesh = tessellateTagged(oc, box);
    const vertCount = mesh.vertices.length / 3;
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertCount);
    }
    // Face groups tile the whole index buffer contiguously.
    const totalGrouped = mesh.faceGroups.reduce((n, g) => n + g.count, 0);
    expect(totalGrouped).toBe(mesh.indices.length);
    box.delete();
  });

  it("gives each edge a polyline and two adjacent-face normals", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const mesh = tessellateTagged(oc, box);
    for (const e of mesh.edges) {
      expect(e.positions.length).toBeGreaterThanOrEqual(6); // ≥ 2 points
      expect(e.faceNormals).toHaveLength(2);
    }
    box.delete();
  });
});

describe("persistent-ref resolution (FR-16)", () => {
  it("re-resolves a captured FaceRef to a face on a rebuilt (resized) box", () => {
    // Capture the +Z top face signature on one box…
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const meshA = tessellateTagged(oc, a);
    const topA = meshA.faceGroups.find((g) => Math.round(g.normal[2]) === 1);
    expect(topA).toBeDefined();
    a.delete();

    // …and resolve it against a differently-sized box (the "rebuild").
    const b = makeBox(oc, mm(80), mm(50), mm(25));
    const face = resolveFaceRef(oc, b, { normal: topA!.normal });
    expect(face).not.toBeNull();
    // The resolved face must actually be the +Z top face, not just any face.
    const n = faceNormal(oc, face!);
    expect(Math.round(n[2])).toBe(1);
    face!.delete();
    b.delete();
  });

  it("re-resolves a captured EdgeRef across a rebuild", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const meshA = tessellateTagged(oc, a);
    const refEdge = meshA.edges[0]!;
    a.delete();

    const b = makeBox(oc, mm(80), mm(50), mm(25));
    const edge = resolveEdgeRef(oc, b, { faceNormals: refEdge.faceNormals });
    expect(edge).not.toBeNull();
    edge!.delete();
    b.delete();
  });
});
