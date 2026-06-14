// mesh/normals — UNIT tests against the REAL OCCT wasm. Covers every exported
// function: shapeEnums, ensureMeshed, faceNormal, faceCentroid, edgeMidpoint, and
// the low-level nodeWorld / normalFromTriangulation / adjacentFaceNormals (driven
// through a real box's triangulation + edge-ancestor map).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { dot } from "../math/index.js";
import { resolveFaceRef } from "./resolve.js";
import {
  MESH_PURPOSE,
  adjacentFaceNormals,
  edgeMidpoint,
  ensureMeshed,
  faceCentroid,
  faceNormal,
  nodeWorld,
  normalFromTriangulation,
  shapeEnums,
} from "./normals.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("normals — shapeEnums / ensureMeshed (unit)", () => {
  it("shapeEnums exposes the TopAbs members", () => {
    const S = shapeEnums(oc);
    expect(S.TopAbs_FACE).toBeDefined();
    expect(S.TopAbs_EDGE).toBeDefined();
    expect(S.TopAbs_SOLID).toBeDefined();
  });

  it("ensureMeshed is idempotent (a second call is cheap + no-throw)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    expect(() => {
      ensureMeshed(oc, box.shape);
      ensureMeshed(oc, box.shape);
    }).not.toThrow();
    box.delete();
  });
});

describe("normals — faceNormal / faceCentroid (unit)", () => {
  it("the +Z face's outward normal is [0,0,1], centroid at (dx/2,dy/2,dz)", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] })!; // resolve meshes the solid
    const n = faceNormal(oc, face);
    expect(n[2]).toBeCloseTo(1, 6);
    expect(Math.hypot(n[0], n[1])).toBeCloseTo(0, 6);
    const c = faceCentroid(oc, face);
    expect(c[0]).toBeCloseTo(mm(30), 6);
    expect(c[1]).toBeCloseTo(mm(20), 6);
    expect(c[2]).toBeCloseTo(mm(30), 6);
    face.delete();
    box.delete();
  });

  it("faceNormal throws on an un-meshed face (violated-invariant guard)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10)); // fresh, NOT meshed
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    const face = oc.TopoDS.Face_1(exp.Current());
    expect(() => faceNormal(oc, face)).toThrow(/no triangulation/);
    face.delete();
    exp.delete();
    box.delete();
  });
});

describe("normals — low-level triangulation helpers (unit)", () => {
  it("nodeWorld + normalFromTriangulation read a face's triangulation", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] })!; // meshes + +Z face at z=dz
    const loc = new oc.TopLoc_Location_1();
    const handle = oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE);
    expect(handle.IsNull()).toBe(false);
    const tri = handle.get();
    const identity = loc.IsIdentity();
    const trsf = loc.Transformation();

    const node = nodeWorld(tri, 1, identity, trsf);
    expect(node.every(Number.isFinite)).toBe(true);
    expect(node[2]).toBeCloseTo(mm(20), 6); // +Z face nodes all sit at z = dz

    const raw = normalFromTriangulation(tri, identity, trsf, false);
    expect(Math.abs(raw[2])).toBeCloseTo(1, 6); // ±Z before orientation flip

    trsf.delete();
    handle.delete();
    loc.delete();
    face.delete();
    box.delete();
  });
});

describe("normals — edge helpers (unit)", () => {
  it("adjacentFaceNormals returns the two perpendicular normals at a box edge; edgeMidpoint is finite", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    ensureMeshed(oc, box.shape);
    const S = shapeEnums(oc);
    const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
    oc.TopExp.MapShapesAndAncestors(box.shape, S.TopAbs_EDGE, S.TopAbs_FACE, map);

    const [n1, n2] = adjacentFaceNormals(oc, map.FindFromIndex(1));
    expect(n1.every(Number.isFinite)).toBe(true);
    expect(n2.every(Number.isFinite)).toBe(true);
    expect(Math.abs(dot(n1, n2))).toBeCloseTo(0, 6); // a box edge joins perpendicular faces

    const edge = oc.TopoDS.Edge_1(map.FindKey(1));
    expect(edgeMidpoint(oc, edge).every(Number.isFinite)).toBe(true);
    edge.delete();
    map.delete();
    box.delete();
  });
});
