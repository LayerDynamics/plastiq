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
      // group normal points +Z but the two triangles face -Y → not planar; and with no
      // rotational spread in the normals there is no cylinder axis either → curved.
      faceGroups: [{ normal: [0, 0, 1], centroid: [0.005, 0, 0.005], start: 0, count: 6 }],
      edges: [],
    };
    expect(inspectMesh(curved).faces[0]!.kind).toBe("curved");
  });
});

/** Lateral wall of a right circular cylinder around +Z (radius r, height h): `segs`
 * quad panels split into triangles, vertices ON the true surface — the same property a
 * real tessellation has. `scaleY` ≠ 1 turns it into an elliptical (non-circular) wall. */
function tubeMesh(r: number, h: number, segs: number, scaleY = 1): MeshView {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    vertices.push(r * Math.cos(t), scaleY * r * Math.sin(t), 0);
    vertices.push(r * Math.cos(t), scaleY * r * Math.sin(t), h);
  }
  for (let i = 0; i < segs; i++) {
    const b0 = 2 * i;
    indices.push(b0, b0 + 2, b0 + 1, b0 + 2, b0 + 3, b0 + 1);
  }
  return {
    vertices,
    indices,
    faceGroups: [{ normal: [1, 0, 0], centroid: [0, 0, h / 2], start: 0, count: indices.length }],
    edges: [],
  };
}

/** Lateral surface of a cone (apex on +Z, base circle radius r at z=0) — normals sit at
 * a constant NON-zero angle to the axis, so it must NOT classify as cylindrical. */
function coneMesh(r: number, h: number, segs: number): MeshView {
  const vertices: number[] = [0, 0, h];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    vertices.push(r * Math.cos(t), r * Math.sin(t), 0);
  }
  for (let i = 1; i <= segs; i++) indices.push(0, i, i + 1);
  return {
    vertices,
    indices,
    faceGroups: [{ normal: [1, 0, 0], centroid: [0, 0, h / 3], start: 0, count: indices.length }],
    edges: [],
  };
}

describe("R3.1 inspectMesh — cylindrical classification (FR-11)", () => {
  it("classifies a circular cylinder wall as cylindrical, with its real radius in mm", () => {
    const f = inspectMesh(tubeMesh(0.005, 0.01, 16)).faces[0]!;
    expect(f.kind).toBe("cylindrical");
    expect(f.radius).toBeCloseTo(5, 3); // 0.005 m → 5 mm
  });

  it("names the radius in the text enumeration for a cylindrical face", () => {
    const t = inspectMesh(tubeMesh(0.005, 0.01, 16)).text;
    expect(t).toContain("cylindrical (radius 5.0 mm)");
  });

  it("keeps a non-circular (elliptical) extruded wall as curved — constant radius is required", () => {
    const f = inspectMesh(tubeMesh(0.005, 0.01, 16, 0.6)).faces[0]!;
    expect(f.kind).toBe("curved");
    expect(f.radius).toBeUndefined();
  });

  it("keeps a cone as curved — its normals are not perpendicular to any one axis", () => {
    const f = inspectMesh(coneMesh(0.005, 0.01, 16)).faces[0]!;
    expect(f.kind).toBe("curved");
    expect(f.radius).toBeUndefined();
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
