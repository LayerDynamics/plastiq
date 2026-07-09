// tessellateTagged edge-pass error paths — UNIT (fake kernel, NOT real OCCT).
//
// Five behaviours under test (Review #18 + finding 8-M3):
//  1. The per-edge catch is NARROW: only the documented missing-triangulation
//     case (an adjacent face dropped in the face pass) skips the edge — counted
//     in `droppedEdges` — while any other error re-throws instead of silently
//     thinning the mesh.
//  2. An adjacent-face handle is freed even when faceCentroid throws mid-edge
//     (it formerly leaked), and the edge handle / edge-face map are freed on the
//     re-throw path too.
//  3. Emitted edges keep COMPACT consecutive edgeIds (`edges[e.edgeId] === e`) —
//     a skipped edge leaves no gap, matching how faceId skips dropped faces.
//  4. Two DISTINCT faces with a byte-identical area centroid (8-M3: a shelled
//     tube's inner/outer walls) resolve to their OWN ids by exact B-rep identity
//     (IsSame) — never last-inserted-wins. The fake kernel pins the byte-equal
//     key deterministically; real GProp quadrature noise makes the equality
//     build-dependent (see tessellate.collision.test.ts for the real-OCCT side).
//  5. An edge-adjacent face that matches NO face group resolves to faceId -1 and
//     is COUNTED in `unresolvedEdgeFaces` — visible data loss, never silent.
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
  /** Area centroid handed out via the fake GProps — controls the map key. */
  centroid: readonly [number, number, number];
  Orientation_1: () => string;
  /** Exact B-rep identity, as the collision-bucket resolution uses it. */
  IsSame: (other: FakeFace) => boolean;
  delete: () => void;
}

const face = (
  label: string,
  opts?: {
    gpropThrows?: boolean;
    triNull?: boolean;
    centroid?: readonly [number, number, number];
  },
): FakeFace => {
  const f: FakeFace = {
    label,
    gpropThrows: opts?.gpropThrows ?? false,
    triNull: opts?.triNull ?? false,
    centroid: opts?.centroid ?? [0.5, 0.5, 0],
    Orientation_1: () => "FORWARD",
    IsSame: (other: FakeFace) => other === f,
    delete: del(label),
  };
  return f;
};

interface FakeEdgeSpec {
  key: string;
  faceA: FakeFace;
  faceB: FakeFace;
}

function makeOc(edgeSpecs: FakeEdgeSpec[], opts?: { faces?: FakeFace[] }): Occt {
  let mapCalls = 0;
  // Faces the FACE pass enumerates (default none: most cases drive the EDGE pass
  // only; the collision cases enumerate faces so the centroid buckets exist).
  const enumFaces = opts?.faces ?? [];
  // The face most recently handed to SurfaceProperties_1 — its centroid is what
  // the paired GProps hands back, matching the real call sequence.
  let gpropFace: FakeFace | null = null;
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
    TopExp_Explorer_2: function () {
      let i = 0;
      return {
        More: () => i < enumFaces.length,
        Next: () => {
          i++;
        },
        Current: () => enumFaces[i],
        delete: () => {},
      };
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
      return {
        CentreOfMass: () => {
          const c = gpropFace?.centroid ?? [0.5, 0.5, 0];
          return point(c[0], c[1], c[2]);
        },
        delete: () => {},
      };
    },
    BRepGProp: {
      SurfaceProperties_1: (f: FakeFace) => {
        if (f.gpropThrows) throw new Error("Standard_Failure: SurfaceProperties failed");
        gpropFace = f;
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

  it("counts adjacent faces that match no face group in unresolvedEdgeFaces, ids -1", () => {
    // This fake enumerates NO faces (empty face pass), so both of the edge's
    // adjacent-face lookups miss: each falls back to -1 AND is counted — the
    // silent `?? -1` path of finding 8-M3 is now visible on the returned mesh.
    const oc = makeOc([{ key: "edge-0", faceA: face("fA0"), faceB: face("fB0") }]);

    const mesh = tessellateTagged(oc, fakeSolid());
    expect(mesh.unresolvedEdgeFaces).toBe(2);
    expect(mesh.edges).toHaveLength(1);
    expect(mesh.edges[0]!.faceIds).toEqual([-1, -1]);
  });
});

describe("centroid-key collisions resolve by exact face identity (8-M3)", () => {
  it("two faces with a byte-identical centroid get their OWN ids, not last-inserted-wins", () => {
    // A shelled tube's inner/outer walls: DISTINCT faces, identical area centroid.
    const inner = face("inner", { centroid: [0, 0, 0.015] });
    const outer = face("outer", { centroid: [0, 0, 0.015] });
    const cap = face("cap", { centroid: [0, 0, 0.03] });
    const oc = makeOc(
      [
        { key: "edge-inner-rim", faceA: inner, faceB: cap },
        { key: "edge-outer-rim", faceA: outer, faceB: cap },
      ],
      { faces: [inner, outer, cap] },
    );

    const mesh = tessellateTagged(oc, fakeSolid());
    expect(mesh.faceGroups.map((g) => g.faceId)).toEqual([0, 1, 2]);
    // Pre-fix the map kept only the LAST colliding face (outer, id 1), so the
    // inner rim silently recorded outer's id. Exact identity resolves each wall.
    expect(mesh.edges[0]!.faceIds).toEqual([0, 2]); // inner rim → inner wall's id
    expect(mesh.edges[1]!.faceIds).toEqual([1, 2]); // outer rim → outer wall's id
    expect(mesh.unresolvedEdgeFaces).toBe(0);
  });

  it("a collision bucket matching NO retained face counts as unresolved — never a wrong id", () => {
    const a = face("a", { centroid: [1, 2, 3] });
    const b = face("b", { centroid: [1, 2, 3] });
    // Same centroid as the bucket pair but never enumerated in the face pass —
    // exact identity matches neither entry, so it must NOT be guessed into one.
    const stranger = face("stranger", { centroid: [1, 2, 3] });
    const oc = makeOc([{ key: "edge-0", faceA: stranger, faceB: a }], { faces: [a, b] });

    const mesh = tessellateTagged(oc, fakeSolid());
    expect(mesh.edges[0]!.faceIds).toEqual([-1, 0]);
    expect(mesh.unresolvedEdgeFaces).toBe(1);
  });
});
