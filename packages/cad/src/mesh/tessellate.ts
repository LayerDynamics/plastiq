// Tagged tessellation — mesh a solid into ONE buffer partitioned into per-face
// render groups, plus per-edge polylines and per-corner points, each carrying a
// persistent signature (face outward normal; edge's two adjacent-face normals).
//
// Built directly on OCCT (BRepMesh_IncrementalMesh + BRep_Tool.Triangulation).
// All OCCT temporaries are freed; the only retained data is plain JS arrays.

import type { TopoDS_Edge, TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import {
  MESH_PURPOSE,
  adjacentFaceNormals,
  edgeMidpoint,
  faceCentroid,
  nodeWorld,
  normalFromTriangulation,
  shapeEnums,
} from "./normals.js";
import type {
  FaceGroup,
  TaggedEdge,
  TaggedMesh,
  TessellateOptions,
  VertexPoint,
} from "./tagged.js";

const DEFAULT_DEFLECTION = 1e-4; // 0.1 mm
const DEFAULT_ANGULAR = 0.5;

/** Discretize an edge into a flat world-space polyline `[x,y,z, …]`. */
function discretizeEdge(oc: Occt, edge: TopoDS_Edge, deflection: number): number[] {
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  const sampler = new oc.GCPnts_UniformDeflection_2(curve, deflection, false);
  const positions: number[] = [];
  if (sampler.IsDone() && sampler.NbPoints() >= 2) {
    const n = sampler.NbPoints();
    for (let i = 1; i <= n; i++) {
      const p = sampler.Value(i);
      positions.push(p.X(), p.Y(), p.Z());
      p.delete();
    }
  } else {
    // Degenerate sampler: fall back to the curve endpoints.
    const u0 = curve.FirstParameter();
    const u1 = curve.LastParameter();
    for (const u of [u0, u1]) {
      const p = curve.Value(u);
      positions.push(p.X(), p.Y(), p.Z());
      p.delete();
    }
  }
  sampler.delete();
  curve.delete();
  return positions;
}

/**
 * Tessellate `solid` into a tagged mesh. The solid is meshed in place (OCCT
 * caches the triangulation on the shape); only plain-JS arrays are returned.
 */
export function tessellateTagged(
  oc: Occt,
  solid: Solid,
  opts?: TessellateOptions,
): TaggedMesh {
  const deflection = opts?.linearDeflection ?? DEFAULT_DEFLECTION;
  const angular = opts?.angularDeflection ?? DEFAULT_ANGULAR;
  const shape: TopoDS_Shape = solid.shape;

  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angular, false);
  mesher.delete();

  const vertices: number[] = [];
  const indices: number[] = [];
  const faceGroups: FaceGroup[] = [];
  let droppedFaces = 0;

  // --- Faces: per-face render groups + outward-normal signature.
  const S = shapeEnums(oc);
  const fexp = new oc.TopExp_Explorer_2(shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let faceId = 0;
  for (; fexp.More(); fexp.Next()) {
    const face = oc.TopoDS.Face_1(fexp.Current());
    const loc = new oc.TopLoc_Location_1();
    const handle = oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE);
    if (handle.IsNull()) {
      // A face with no triangulation is omitted from the mesh. Valid solids
      // triangulate at this deflection, so this is rare — count it on the returned
      // mesh (droppedFaces) so callers can surface the partial result instead of
      // treating the shorter mesh as complete. The console.warn is a dev aid only.
      console.warn(`tessellateTagged: face ${faceId} has no triangulation (deflection ${deflection}) — omitted from the mesh`);
      droppedFaces++;
      handle.delete();
      loc.delete();
      face.delete();
      continue;
    }
    const tri = handle.get();
    const identity = loc.IsIdentity();
    const trsf = loc.Transformation();
    const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

    const base = vertices.length / 3;
    const nbNodes = tri.NbNodes();
    for (let i = 1; i <= nbNodes; i++) {
      const w = nodeWorld(tri, i, identity, trsf);
      vertices.push(w[0], w[1], w[2]);
    }

    const start = indices.length;
    const nbTri = tri.NbTriangles();
    for (let i = 1; i <= nbTri; i++) {
      const t = tri.Triangle(i);
      const n1 = base + (t.Value(1) - 1);
      const n2 = base + (t.Value(2) - 1);
      const n3 = base + (t.Value(3) - 1);
      // Flip winding for REVERSED faces so the triangle normal points outward.
      if (reversed) indices.push(n1, n3, n2);
      else indices.push(n1, n2, n3);
      t.delete();
    }
    const count = indices.length - start;
    const normal = normalFromTriangulation(tri, identity, trsf, reversed);
    const centroid = faceCentroid(oc, face);
    faceGroups.push({
      start,
      count,
      faceId,
      normal: [normal[0], normal[1], normal[2]],
      centroid: [centroid[0], centroid[1], centroid[2]],
    });
    faceId++;

    trsf.delete();
    handle.delete();
    loc.delete();
    face.delete();
  }
  fexp.delete();

  // Centroid → face-group id, so an edge can record which two faces it joins (M2: the
  // dihedral-convexity test needs the adjacent faces' centroids). The face centroid is computed
  // by the SAME `faceCentroid` as `faceGroups`, so the key matches exactly. (ADR-0002.)
  const centroidToFaceId = new Map<string, number>();
  for (const g of faceGroups) centroidToFaceId.set(g.centroid.join(","), g.faceId);

  // --- Edges: world polylines + two adjacent-face normals (EdgeRef signature).
  const edges: TaggedEdge[] = [];
  const edgeFaceMap = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(shape, S.TopAbs_EDGE, S.TopAbs_FACE, edgeFaceMap);
  const edgeCount = edgeFaceMap.Extent();
  for (let i = 1; i <= edgeCount; i++) {
    const edge = oc.TopoDS.Edge_1(edgeFaceMap.FindKey(i));
    const faceList = edgeFaceMap.FindFromIndex(i);
    try {
      // adjacentFaceNormals reads the adjacent faces' triangulations; if one of
      // them was dropped above (no triangulation), faceNormal throws. Skip such an
      // edge — without both adjacent normals it has no persistent signature, and
      // it borders the already-counted missing face. Fabricating a normal here is
      // exactly the silent-corruption this avoids.
      const [na, nb] = adjacentFaceNormals(oc, faceList);
      // The two adjacent faces' ids, same order as [na, nb] (First/Last, matching
      // adjacentFaceNormals). Resolved by centroid, which is byte-identical to the face group's.
      const fA = oc.TopoDS.Face_1(faceList.First_1());
      const cA = faceCentroid(oc, fA);
      fA.delete();
      let cB = cA;
      if (faceList.Size() >= 2) {
        const fB = oc.TopoDS.Face_1(faceList.Last_1());
        cB = faceCentroid(oc, fB);
        fB.delete();
      }
      const idA = centroidToFaceId.get(cA.join(",")) ?? -1;
      const idB = centroidToFaceId.get(cB.join(",")) ?? -1;
      const positions = discretizeEdge(oc, edge, deflection);
      const mid = edgeMidpoint(oc, edge);
      edges.push({
        edgeId: i - 1,
        positions,
        faceNormals: [
          [na[0], na[1], na[2]],
          [nb[0], nb[1], nb[2]],
        ],
        faceIds: [idA, idB],
        midpoint: [mid[0], mid[1], mid[2]],
      });
    } catch {
      // edge omitted (adjacent face has no triangulation) — see droppedFaces.
    }
    edge.delete();
  }
  edgeFaceMap.delete();

  // --- Vertices: unique B-rep corners.
  const vertexPoints: VertexPoint[] = [];
  const vertMap = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(shape, S.TopAbs_VERTEX, S.TopAbs_EDGE, vertMap);
  const vertCount = vertMap.Extent();
  for (let i = 1; i <= vertCount; i++) {
    const vertex = oc.TopoDS.Vertex_1(vertMap.FindKey(i));
    const p = oc.BRep_Tool.Pnt(vertex);
    vertexPoints.push({ vertexId: i - 1, position: [p.X(), p.Y(), p.Z()] });
    p.delete();
    vertex.delete();
  }
  vertMap.delete();

  return { vertices, indices, faceGroups, edges, vertexPoints, droppedFaces };
}
