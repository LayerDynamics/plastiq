// Tagged tessellation — mesh a solid into ONE buffer partitioned into per-face
// render groups, plus per-edge polylines and per-corner points, each carrying a
// persistent signature (face outward normal; edge's two adjacent-face normals).
//
// Built directly on OCCT (BRepMesh_IncrementalMesh + BRep_Tool.Triangulation).
// All OCCT temporaries are freed; the only retained data is plain JS arrays.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from "opencascade.js";

import { analyzeFreeBounds } from "../action/heal.js";
import type { Occt } from "../oc/init.js";
import { bodyKindOf, shapeMayHaveFreeEdges } from "../solid/bodyKind.js";
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
import { faceSurfaceSignature, type SurfaceSignature } from "./surface.js";
import type {
  FaceGroup,
  TaggedEdge,
  TaggedMesh,
  TessellateOptions,
  VertexPoint,
} from "./tagged.js";

const DEFAULT_DEFLECTION = 1e-4; // 0.1 mm
const DEFAULT_ANGULAR = 0.5;

/**
 * True for the ONE documented skippable per-edge failure: an adjacent face with
 * no triangulation (`faceNormal` throws this after such a face was dropped —
 * and counted — in the face pass). Anything else is a real error and must
 * surface, not be swallowed.
 */
function isMissingTriangulationError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no triangulation");
}

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
export function tessellateTagged(oc: Occt, solid: Solid, opts?: TessellateOptions): TaggedMesh {
  const deflection = opts?.linearDeflection ?? DEFAULT_DEFLECTION;
  const angular = opts?.angularDeflection ?? DEFAULT_ANGULAR;
  const shape: TopoDS_Shape = solid.shape;

  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angular, false);
  mesher.delete();

  const vertices: number[] = [];
  const indices: number[] = [];
  const faceGroups: FaceGroup[] = [];
  // Face handles retained through the edge pass (index == faceId), so a centroid-key
  // collision can be resolved by exact B-rep identity (IsSame). Freed after that pass.
  const faceShapes: TopoDS_Face[] = [];
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
      console.warn(
        `tessellateTagged: face ${faceId} has no triangulation (deflection ${deflection}) — omitted from the mesh`,
      );
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
      // Read off the B-rep surface, not the mesh — the only signature that
      // identifies a closed curved face (§2.1).
      surface: faceSurfaceSignature(oc, face),
    });
    faceId++;

    trsf.delete();
    handle.delete();
    loc.delete();
    // NOT freed yet: retained (index == faceId, matching the push order above) for
    // exact-identity resolution in the edge pass.
    faceShapes.push(face);
  }
  fexp.delete();

  // Centroid → face-group ids, so an edge can record which two faces it joins (M2: the
  // dihedral-convexity test needs the adjacent faces' centroids). The face centroid is computed
  // by the SAME `faceCentroid` as `faceGroups`, so the key matches exactly. (ADR-0002.)
  // Distinct faces CAN share an area centroid (a shelled tube's inner and outer lateral walls
  // both centre on the axis midpoint), so each key holds a BUCKET of candidate ids — a
  // multi-id bucket is resolved below by exact B-rep identity (IsSame) against the retained
  // face handles, never by last-inserted-wins (which silently recorded the WRONG faceId).
  const centroidToFaceIds = new Map<string, number[]>();
  for (const g of faceGroups) {
    const key = g.centroid.join(",");
    const bucket = centroidToFaceIds.get(key);
    if (bucket) bucket.push(g.faceId);
    else centroidToFaceIds.set(key, [g.faceId]);
  }

  let unresolvedEdgeFaces = 0;
  /** The face-group id of an edge-adjacent `face` (still owned by the caller): unique-centroid
   * fast path, exact `IsSame` identity within a centroid-collision bucket. `-1` — counted in
   * `unresolvedEdgeFaces` so the residual data loss stays visible (mirroring droppedFaces /
   * droppedEdges) — only when the face matches no group at all. */
  const resolveAdjacentFaceId = (face: TopoDS_Face): number => {
    const bucket = centroidToFaceIds.get(faceCentroid(oc, face).join(","));
    if (bucket) {
      if (bucket.length === 1) return bucket[0]!;
      for (const id of bucket) {
        const retained = faceShapes[id];
        if (retained !== undefined && face.IsSame(retained)) return id;
      }
    }
    unresolvedEdgeFaces++;
    return -1;
  };

  // --- Edges: world polylines + two adjacent-face normals (EdgeRef signature).
  // Free-edge flags (§14) only on open sheets: MapShapesAndAncestors Size < 2
  // also matches cylindrical SEAMS on closed solids, so we never set isFree there.
  // Body-kind probe is best-effort so unit fakes without ShapeType still tessellate.
  let mayHaveFreeEdges = false;
  try {
    mayHaveFreeEdges = shapeMayHaveFreeEdges(oc, solid);
  } catch {
    // Unit fakes may omit ShapeType; the initialized false value is the safe fallback.
  }
  const edges: TaggedEdge[] = [];
  let droppedEdges = 0;
  const edgeFaceMap = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  try {
    oc.TopExp.MapShapesAndAncestors(shape, S.TopAbs_EDGE, S.TopAbs_FACE, edgeFaceMap);
    const edgeCount = edgeFaceMap.Extent();
    for (let i = 1; i <= edgeCount; i++) {
      const edge = oc.TopoDS.Edge_1(edgeFaceMap.FindKey(i));
      try {
        const faceList = edgeFaceMap.FindFromIndex(i);
        // adjacentFaceNormals reads the adjacent faces' triangulations; if one of
        // them was dropped above (no triangulation), faceNormal throws. Skip such an
        // edge — without both adjacent normals it has no persistent signature, and
        // it borders the already-counted missing face. Fabricating a normal here is
        // exactly the silent-corruption this avoids.
        const [na, nb] = adjacentFaceNormals(oc, faceList);
        // The two adjacent faces' ids, same order as [na, nb] (First/Last, matching
        // adjacentFaceNormals). Resolved by centroid — byte-identical to the face group's —
        // plus exact identity on a collision. Each handle stays alive through resolution (the
        // collision path compares it via IsSame) and is freed even if faceCentroid throws.
        const fA = oc.TopoDS.Face_1(faceList.First_1());
        let idA: number;
        let surfA: SurfaceSignature;
        try {
          idA = resolveAdjacentFaceId(fA);
          // Read the analytic surface off the FACE, not off `faceGroups[idA]`:
          // an adjacent face that resolves to no group (id -1, counted in
          // unresolvedEdgeFaces) has no group to read from. Deriving it from the
          // B-rep is deterministic, so it is identical to the group's anyway.
          surfA = faceSurfaceSignature(oc, fA);
        } finally {
          fA.delete();
        }
        let idB = idA;
        let surfB = surfA;
        if (faceList.Size() >= 2) {
          const fB = oc.TopoDS.Face_1(faceList.Last_1());
          try {
            idB = resolveAdjacentFaceId(fB);
            surfB = faceSurfaceSignature(oc, fB);
          } finally {
            fB.delete();
          }
        }
        const positions = discretizeEdge(oc, edge, deflection);
        const mid = edgeMidpoint(oc, edge);
        // One face ancestor on an open sheet ⇒ free (naked) edge for sew/patch UI.
        const isFree = mayHaveFreeEdges && faceList.Size() < 2;
        edges.push({
          // Compact id: a skipped edge leaves no gap, so `edges[e.edgeId] === e`
          // always holds — matching faceId, which also renumbers past dropped
          // faces. Safe for selection: resolve/select re-match by persistent
          // signature (faceNormals/midpoint), never by edgeId, and the app keys
          // its transient pick refs by this same field on this same mesh.
          edgeId: edges.length,
          positions,
          faceNormals: [
            [na[0], na[1], na[2]],
            [nb[0], nb[1], nb[2]],
          ],
          // Same order as faceNormals/faceIds. A seam edge bordering one face
          // repeats it, matching the faceIds contract above (§2.1).
          faceSurfaces: [surfA, surfB],
          faceIds: [idA, idB],
          midpoint: [mid[0], mid[1], mid[2]],
          ...(isFree ? { isFree: true as const } : {}),
        });
      } catch (err) {
        // ONLY the documented case is skippable: an edge bordering a face that was
        // dropped above for having no triangulation (see droppedFaces). Any other
        // failure is a real bug — re-throw instead of silently thinning the mesh.
        if (!isMissingTriangulationError(err)) throw err;
        droppedEdges++;
      } finally {
        edge.delete();
      }
    }
  } finally {
    edgeFaceMap.delete();
    // The retained face handles have served identity resolution — free them (throw path too).
    for (const f of faceShapes) f.delete();
  }

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

  // Body kind + free-edge tally (§17 protocol). FreeBounds is cheap topology and
  // is the same gate sew/solidify use; closed solids report 0. Both are best-
  // effort so a missing binding / unit fake never blanks an otherwise-good mesh.
  let bodyKind: TaggedMesh["bodyKind"];
  try {
    bodyKind = bodyKindOf(oc, solid);
  } catch {
    bodyKind = undefined;
  }
  let freeEdgeCount: number | undefined;
  try {
    freeEdgeCount = analyzeFreeBounds(oc, shape).freeEdgeCount;
  } catch {
    freeEdgeCount = undefined;
  }

  return {
    vertices,
    indices,
    faceGroups,
    edges,
    vertexPoints,
    droppedFaces,
    droppedEdges,
    unresolvedEdgeFaces,
    ...(bodyKind !== undefined ? { bodyKind } : {}),
    ...(freeEdgeCount !== undefined ? { freeEdgeCount } : {}),
  };
}
