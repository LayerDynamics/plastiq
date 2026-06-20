// SPEC-6 R3.1 (T3.1): pure mesh inspection — area/length/planarity computation,
// index-aligned refs, and the text enumeration. Synthetic mesh, no OCCT.

import { describe, it, expect } from "vitest";
import { inspectMesh, inspectGeometry, type MeshView } from "./inspectGeometry.js";

// A single 10mm × 10mm right-triangle face (area 50 mm²) on the XY plane, plus one
// 10mm straight edge. Coordinates are SI metres.
const triMesh = (): MeshView => ({
  vertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0],
  indices: [0, 1, 2],
  faceGroups: [{ normal: [0, 0, 1], centroid: [0.0033, 0.0033, 0], start: 0, count: 3 }],
  edges: [{ faceNormals: [[0, 0, 1], [1, 0, 0]], midpoint: [0.005, 0, 0], positions: [0, 0, 0, 0.01, 0, 0] }],
});

describe("R3.1 inspectMesh", () => {
  it("computes face area in mm², planar kind, and index-aligned faceRefs", () => {
    const ins = inspectMesh(triMesh());
    expect(ins.faces).toHaveLength(1);
    expect(ins.faces[0]!.area).toBeCloseTo(50, 1);
    expect(ins.faces[0]!.kind).toBe("planar");
    expect(ins.faceRefs[0]).toEqual({ normal: [0, 0, 1], centroid: [0.0033, 0.0033, 0] });
  });

  it("computes edge length in mm, straightness, and edgeRefs", () => {
    const ins = inspectMesh(triMesh());
    expect(ins.edges[0]!.length).toBeCloseTo(10, 6);
    expect(ins.edges[0]!.straight).toBe(true);
    expect(ins.edgeRefs[0]).toEqual({ faceNormals: [[0, 0, 1], [1, 0, 0]], midpoint: [0.005, 0, 0] });
  });

  it("enumerates faces and edges as mm text", () => {
    const t = inspectMesh(triMesh()).text;
    expect(t).toContain("Face 0");
    expect(t).toContain("Edge 0");
    expect(t).toMatch(/mm/);
  });

  it("flags a curved face when triangle normals diverge from the face normal", () => {
    const curved: MeshView = {
      vertices: [0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0.01, 0, 0.01],
      indices: [0, 1, 2, 1, 3, 2],
      // group normal points +Z but the two triangles face +Z and +X-ish → curved.
      faceGroups: [{ normal: [0, 0, 1], centroid: [0.005, 0, 0.005], start: 0, count: 6 }],
      edges: [],
    };
    expect(inspectMesh(curved).faces[0]!.kind).toBe("curved");
  });
});

describe("R3.1 inspectGeometry tool", () => {
  it("reports empty when the probe yields no mesh", async () => {
    const r = await inspectGeometry({ features: [], params: {} }, async () => null);
    expect(r.status).toBe("empty");
  });

  it("reports ok + faces when the probe yields a mesh", async () => {
    const r = await inspectGeometry({ features: [], params: {} }, async () => triMesh());
    expect(r.status).toBe("ok");
    expect(r.faces).toHaveLength(1);
  });
});
