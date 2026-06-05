// Tagged tessellation (SPEC-5 FR-6): a solid → one merged triangle mesh whose
// triangles are grouped **per B-rep face** + each B-rep **edge** as a polyline,
// so an editor viewport can resolve a picked triangle/line back to the
// topological face/edge it belongs to (the keystone for typed 3D selection).
//
// `faceId`/`edgeId` are the 1-based indices of `TopExp::MapShapes` for this
// solid — stable within a build. Cross-rebuild persistence (so a fillet remembers
// "this edge") is the kernel's `FaceRef`/`EdgeRef` (FR-16); the editor bridges a
// picked id to a persistent reference via the entity's geometric signature.

import type { TopAbs_ShapeEnum } from "opencascade.js";
import { faceNormal } from "../action/selection.js";
import { massProperties } from "../lower/massprops.js";
import type { Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import type { TessellateOptions } from "./tessellate.js";

/** A contiguous range of `indices` belonging to one B-rep face. */
export interface FaceGroup {
  readonly faceId: number;
  /** Offset into `indices` where this face's triangles start. */
  readonly start: number;
  /** Number of index entries (3 × triangle count) for this face. */
  readonly count: number;
  /** Outward normal — the persistent `FaceRef` signature (SPEC-4 FR-16). */
  readonly normal: Vec3;
}

/** One B-rep edge as a world-space polyline. */
export interface EdgePolyline {
  readonly edgeId: number;
  /** Flat SI coordinates `[x0,y0,z0, …]` along the edge. */
  readonly positions: number[];
  /** Adjacent faces' normals — the persistent `EdgeRef` signature (FR-16). */
  readonly faceNormals: readonly [Vec3, Vec3];
}

/** One B-rep topological vertex (a model corner), pickable in vertex mode. */
export interface VertexPoint {
  readonly vertexId: number;
  /** SI position `[x,y,z]`. */
  readonly position: readonly [number, number, number];
}

export interface TaggedMesh {
  /** Flat SI vertex coordinates `[x0,y0,z0, …]`. */
  vertices: number[];
  /** Triangle vertex indices (triples) into `vertices`/3. */
  indices: number[];
  /** Per-face index ranges, in `faceId` order. */
  faceGroups: FaceGroup[];
  /** Per-edge polylines, in `edgeId` order. */
  edges: EdgePolyline[];
  /** B-rep topological vertices (corners), in `vertexId` order. */
  vertexPoints: VertexPoint[];
}

export function tessellateTagged(oc: Occt, solid: Solid, opts: TessellateOptions): TaggedMesh {
  const ang = opts.angularDeflection ?? 0.5;
  new oc.BRepMesh_IncrementalMesh_2(solid.shape, opts.linearDeflection, false, ang, false).delete();

  const vertices: number[] = [];
  const indices: number[] = [];
  const faceGroups: FaceGroup[] = [];
  const edges: EdgePolyline[] = [];
  const vertexPoints: VertexPoint[] = [];

  const faceEnum = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const edgeEnum = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const vertexEnum = oc.TopAbs_ShapeEnum.TopAbs_VERTEX as TopAbs_ShapeEnum;
  const reversedTag = oc.TopAbs_Orientation.TopAbs_REVERSED as unknown as ReturnType<
    ReturnType<Occt["TopoDS"]["Face_1"]>["Orientation_1"]
  >;

  // Solid centroid: orients each face normal outward (the persistent FaceRef /
  // EdgeRef signatures the editor's dress-up features store, SPEC-4 FR-16).
  const com = massProperties(oc, solid, 1).com;
  const center: Vec3 = [com[0], com[1], com[2]];
  const ZERO: Vec3 = [0, 0, 0];

  // Edge map built up front so a face's edges can be indexed (FindIndex) while
  // we accumulate each edge's adjacent-face normals for its EdgeRef.
  const emap = new oc.TopTools_IndexedMapOfShape_1();
  oc.TopExp.MapShapes_1(solid.shape, edgeEnum, emap);
  const edgeAdjacency: Vec3[][] = Array.from({ length: emap.Extent() + 1 }, () => []);

  // --- faces: per-face triangulation + outward normal ----------------------
  const fmap = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_1(solid.shape, faceEnum, fmap);
    for (let fi = 1; fi <= fmap.Extent(); fi++) {
      const face = oc.TopoDS.Face_1(fmap.FindKey(fi));
      const normal = faceNormal(oc, face, center);
      const loc = new oc.TopLoc_Location_1();
      const handle = oc.BRep_Tool.Triangulation(face, loc, undefined as never);
      const start = indices.length;
      if (!handle.IsNull()) {
        const tri = handle.get();
        const trsf = loc.Transformation();
        const reversed = face.Orientation_1() === reversedTag;
        const base = vertices.length / 3;
        const nbNodes = tri.NbNodes();
        for (let i = 1; i <= nbNodes; i++) {
          const node = tri.Node(i);
          const p = node.Transformed(trsf);
          vertices.push(p.X(), p.Y(), p.Z());
          p.delete();
          node.delete();
        }
        const nbTris = tri.NbTriangles();
        for (let i = 1; i <= nbTris; i++) {
          const t = tri.Triangle(i);
          const n1 = t.Value(1);
          const n2 = t.Value(2);
          const n3 = t.Value(3);
          t.delete();
          if (reversed) indices.push(base + n1 - 1, base + n3 - 1, base + n2 - 1);
          else indices.push(base + n1 - 1, base + n2 - 1, base + n3 - 1);
        }
        trsf.delete();
      }
      faceGroups.push({ faceId: fi, start, count: indices.length - start, normal });

      // Record this face's normal against each of its edges (for EdgeRef).
      const exp = new oc.TopExp_Explorer_2(
        face,
        edgeEnum as never,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
      );
      try {
        for (; exp.More(); exp.Next()) {
          const e = oc.TopoDS.Edge_1(exp.Current());
          const idx = emap.FindIndex(e);
          if (idx >= 1) edgeAdjacency[idx]!.push(normal);
          e.delete();
        }
      } finally {
        exp.delete();
      }

      handle.delete();
      loc.delete();
      face.delete();
    }
  } finally {
    fmap.delete();
  }

  // --- edges: discretize each edge curve into a world polyline -------------
  try {
    for (let ei = 1; ei <= emap.Extent(); ei++) {
      const edge = oc.TopoDS.Edge_1(emap.FindKey(ei));
      const positions: number[] = [];
      try {
        const adaptor = new oc.BRepAdaptor_Curve_2(edge);
        // Tangential-deflection discretization: angular + curvature (linear)
        // deflection, ≥2 points. Straight edges → just the two endpoints.
        const gc = new oc.GCPnts_TangentialDeflection_2(
          adaptor,
          ang,
          opts.linearDeflection,
          2,
          1e-9,
          1e-9,
        );
        const n = gc.NbPoints();
        for (let i = 1; i <= n; i++) {
          const p = gc.Value(i);
          positions.push(p.X(), p.Y(), p.Z());
          p.delete();
        }
        gc.delete();
        adaptor.delete();
      } catch {
        // A degenerate edge (e.g. a seam point) yields no polyline; skip it.
      }
      if (positions.length >= 6) {
        const adj = edgeAdjacency[ei]!;
        const faceNormals: readonly [Vec3, Vec3] = [adj[0] ?? ZERO, adj[1] ?? adj[0] ?? ZERO];
        edges.push({ edgeId: ei, positions, faceNormals });
      }
      edge.delete();
    }
  } finally {
    emap.delete();
  }

  // --- vertices: each B-rep corner as a single point -----------------------
  // A dedicated VERTEX map (not edge endpoints) so every corner has one stable
  // id and is never double-counted (advisor R3); id = map index.
  const vmap = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_1(solid.shape, vertexEnum, vmap);
    for (let vi = 1; vi <= vmap.Extent(); vi++) {
      const vertex = oc.TopoDS.Vertex_1(vmap.FindKey(vi));
      const p = oc.BRep_Tool.Pnt(vertex);
      vertexPoints.push({ vertexId: vi, position: [p.X(), p.Y(), p.Z()] });
      p.delete();
      vertex.delete();
    }
  } finally {
    vmap.delete();
  }

  return { vertices, indices, faceGroups, edges, vertexPoints };
}
