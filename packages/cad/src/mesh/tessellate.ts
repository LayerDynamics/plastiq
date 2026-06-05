// Tessellation: B-rep solid → triangle mesh (SPEC-4 Task 0.6 / FR-3).
//
// Used for rendering (Babylon) and as the basis for convex-hull lowering to the
// sim (FR-26). Meshes each face via BRepMesh, then reads the per-face
// Poly_Triangulation, transforming nodes to world coordinates and merging into a
// single indexed mesh. Vertices are flat SI (x,y,z) triples; indices are triangle
// index triples into the vertex list.

import type { TopAbs_ShapeEnum } from "opencascade.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";

export interface Mesh {
  /** Flat SI coordinates: [x0,y0,z0, x1,y1,z1, ...]. */
  vertices: number[];
  /** Triangle vertex indices (triples) into `vertices`/3. */
  indices: number[];
}

export interface TessellateOptions {
  /** Max chordal deviation, SI metres (smaller = finer). */
  linearDeflection: number;
  /** Max angular deviation, radians (default 0.5). */
  angularDeflection?: number;
}

export function tessellate(oc: Occt, solid: Solid, opts: TessellateOptions): Mesh {
  const ang = opts.angularDeflection ?? 0.5;
  // Meshing stores triangulations on the shape's faces (side effect).
  const mesher = new oc.BRepMesh_IncrementalMesh_2(
    solid.shape,
    opts.linearDeflection,
    false,
    ang,
    false,
  );
  mesher.delete();

  const vertices: number[] = [];
  const indices: number[] = [];

  const faceEnum = oc.TopAbs_ShapeEnum.TopAbs_FACE as TopAbs_ShapeEnum;
  const noAvoid = oc.TopAbs_ShapeEnum.TopAbs_SHAPE as TopAbs_ShapeEnum;
  const exp = new oc.TopExp_Explorer_2(solid.shape, faceEnum, noAvoid);
  try {
    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      const loc = new oc.TopLoc_Location_1();
      // Poly_MeshPurpose isn't bound on the instance; the binding accepts
      // `undefined` for the defaulted arg (Poly_MeshPurpose_NONE).
      const handle = oc.BRep_Tool.Triangulation(face, loc, undefined as never);
      if (!handle.IsNull()) {
        const tri = handle.get();
        const trsf = loc.Transformation();
        const reversed =
          face.Orientation_1() ===
          (oc.TopAbs_Orientation.TopAbs_REVERSED as unknown as ReturnType<
            typeof face.Orientation_1
          >);
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
          // OCCT node indices are 1-based, per-face → 0-based, merged.
          if (reversed) {
            indices.push(base + n1 - 1, base + n3 - 1, base + n2 - 1);
          } else {
            indices.push(base + n1 - 1, base + n2 - 1, base + n3 - 1);
          }
        }
        trsf.delete();
      }
      handle.delete();
      loc.delete();
      face.delete();
    }
  } finally {
    exp.delete();
  }

  return { vertices, indices };
}
