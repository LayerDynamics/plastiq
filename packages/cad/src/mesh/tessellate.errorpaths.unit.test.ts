// tessellateTagged edge-pass error paths — UNIT (fake kernel, NOT real OCCT).
//
// Three behaviours under test (Review #18):
//  1. The per-edge catch is NARROW: only the documented missing-triangulation
//     case (an adjacent face dropped in the face pass) skips the edge — counted
//     in `droppedEdges` — while any other error re-throws instead of silently
//     thinning the mesh.
//  2. An adjacent-face handle is freed even when faceCentroid throws mid-edge
//     (it formerly leaked), and the edge handle / edge-face map are freed on the
//     re-throw path too.
//  3. Emitted edges keep COMPACT consecutive edgeIds (`edges[e.edgeId] === e`) —
//     a skipped edge leaves no gap, matching how faceId skips dropped faces.
//
// Same `.delete()`-spy pattern as action/cleanup.unit.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { tessellateTagged } from "./tessellate.js";

let deleted: string[];
const del = (label: string) => () => deleted.push(label);

beforeEach(() => {
  deleted = [];
});

const point = (x: number, y: number, z: number) => ({
  X: () => x,
  Y: () => y,
  Z: () => z,
  delete: () => {},
});

// A one-triangle (+Z) triangulation so the real normalFromTriangulation works.
const tri = {
  NbNodes: () => 3,
  NbTriangles: () => 1,
  Triangle: () => ({ Value: (k: number) => k, delete: () => {} }),
  Node: (i: number) => [point(0, 0, 0), point(1, 0, 0), point(0, 1, 0)][i - 1]!,
};

interface FakeFace {
  label: string;
  gpropThrows: boolean;
  triNull: boolean;
  Orientation_1: () => string;
  delete: () => void;
}

const face = (label: string, opts?: { gpropThrows?: boolean; triNull?: boolean }): FakeFace => ({
  label,
  gpropThrows: opts?.gpropThrows ?? false,
  triNull: opts?.triNull ?? false,
  Orientation_1: () => "FORWARD",
  delete: del(label),
});

interface FakeEdgeSpec {
  key: string;
  faceA: FakeFace;
  faceB: FakeFace;
}

function makeOc(edgeSpecs: FakeEdgeSpec[]): Occt {
  let mapCalls = 0;
  const faceLists = edgeSpecs.map((s) => ({
    First_1: () => s.faceA,
    Last_1: () => s.faceB,
    Size: () => 2,
  }));
  const curve = () => ({
    FirstParameter: () => 0,
    LastParameter: () => 1,
    Value: (u: number) => point(u, 0, 0),
    delete: () => {},
  });
  return {
    BRepMesh_IncrementalMesh_2: function () {
      return { delete: () => {} };
    },
    TopAbs_ShapeEnum: {
      TopAbs_FACE: "FACE",
      TopAbs_EDGE: "EDGE",
      TopAbs_VERTEX: "VERTEX",
      TopAbs_SHAPE: "SHAPE",
    },
    TopAbs_Orientation: { TopAbs_REVERSED: "REVERSED" },
    // No faces enumerated: the face pass is exercised by the real-wasm suites;
    // here we drive the EDGE pass only.
    TopExp_Explorer_2: function () {
      return { More: () => false, Next: () => {}, delete: () => {} };
    },
    TopLoc_Location_1: function () {
      return { IsIdentity: () => true, Transformation: () => ({ delete: () => {} }), delete: () => {} };
    },
    BRep_Tool: {
      Triangulation: (f: FakeFace) =>
        f.triNull
          ? { IsNull: () => true, delete: () => {} }
          : { IsNull: () => false, get: () => tri, delete: () => {} },
    },
    TopoDS: {
      Face_1: (f: FakeFace) => f,
      Edge_1: (key: string) => ({ delete: del(key) }),
    },
    TopExp: { MapShapesAndAncestors: () => {} },
    TopTools_IndexedDataMapOfShapeListOfShape_1: function () {
      mapCalls++;
      if (mapCalls === 1) {
        return {
          Extent: () => edgeSpecs.length,
          FindKey: (i: number) => edgeSpecs[i - 1]!.key,
          FindFromIndex: (i: number) => faceLists[i - 1]!,
          delete: del("edgeMap"),
        };
      }
      return { Extent: () => 0, delete: del("vertMap") };
    },
    GProp_GProps_1: function () {
      return { CentreOfMass: () => point(0.5, 0.5, 0), delete: () => {} };
    },
    BRepGProp: {
      SurfaceProperties_1: (f: FakeFace) => {
        if (f.gpropThrows) throw new Error("Standard_Failure: SurfaceProperties failed");
      },
    },
    BRepAdaptor_Curve_2: function () {
      return curve();
    },
    GCPnts_UniformDeflection_2: function () {
      return { IsDone: () => true, NbPoints: () => 2, Value: (i: number) => point(i, 0, 0), delete: () => {} };
    },
  } as unknown as Occt;
}

const fakeSolid = (): Solid => ({ shape: {} }) as unknown as Solid;

describe("the per-edge catch only skips the documented missing-triangulation case", () => {
  it("skips an edge whose adjacent face has no triangulation, counts it, and compacts edgeId", () => {
    const oc = makeOc([
      { key: "edge-0", faceA: face("fA0"), faceB: face("fB0") },
      // faceNormal throws its documented "no triangulation" error for this one.
      { key: "edge-1", faceA: face("BAD", { triNull: true }), faceB: face("fB1") },
      { key: "edge-2", faceA: face("fA2"), faceB: face("fB2") },
    ]);

    const mesh = tessellateTagged(oc, fakeSolid());
    expect(mesh.droppedEdges).toBe(1);
    expect(mesh.edges).toHaveLength(2);
    // Compact ids: the skipped edge leaves NO gap — edges[e.edgeId] === e.
    expect(mesh.edges.map((e) => e.edgeId)).toEqual([0, 1]);
    // Every edge handle is freed, including the skipped edge's, and the map.
    expect(deleted).toEqual(
      expect.arrayContaining(["edge-0", "edge-1", "edge-2", "edgeMap", "vertMap"]),
    );
  });

  it("re-throws any OTHER error instead of silently thinning the mesh", () => {
    const oc = makeOc([
      { key: "edge-0", faceA: face("fA"), faceB: face("fB", { gpropThrows: true }) },
    ]);

    expect(() => tessellateTagged(oc, fakeSolid())).toThrow(/SurfaceProperties/);
    // The adjacent-face handle is freed even though faceCentroid threw (it
    // formerly leaked), and the edge + edge-face map are freed on the way out.
    expect(deleted).toEqual(expect.arrayContaining(["fB", "edge-0", "edgeMap"]));
  });

  it("a clean solid reports zero droppedEdges and full signatures", () => {
    const oc = makeOc([
      { key: "edge-0", faceA: face("fA0"), faceB: face("fB0") },
      { key: "edge-1", faceA: face("fA1"), faceB: face("fB1") },
    ]);

    const mesh = tessellateTagged(oc, fakeSolid());
    expect(mesh.droppedEdges).toBe(0);
    expect(mesh.droppedFaces).toBe(0);
    expect(mesh.edges).toHaveLength(2);
    expect(mesh.edges.map((e) => e.edgeId)).toEqual([0, 1]);
    for (const e of mesh.edges) {
      expect(e.faceNormals[0]).toEqual([0, 0, 1]);
      expect(e.faceNormals[1]).toEqual([0, 0, 1]);
      expect(e.positions).toHaveLength(6); // two sampled polyline points
      expect(e.midpoint).toBeDefined();
    }
  });
});
