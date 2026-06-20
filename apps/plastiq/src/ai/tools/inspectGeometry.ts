// SPEC-6 R3.1 — the inspect_geometry tool (FR-11, FR-12).
//
// Builds the current part and serializes its tagged mesh into a structured,
// text-friendly enumeration of faces and edges (with normals, positions, real
// computed area/length, and a planar/straight hint) — no rendered image needed
// (spec §6.3). The model references faces/edges by INDEX; `faceRefs`/`edgeRefs`
// are index-aligned so the client writes the concrete FaceRef/EdgeRef into a
// dress-up feature's data (these resolve on rebuild via resolveFaceRef/Edge).

import type { FaceRef, EdgeRef } from "@plastiq/cad";
import type { CadDocument } from "../../store/types.js";
import { toMm } from "@plastiq/cad";

type V3 = [number, number, number];

/** The minimal mesh shape inspect needs — satisfied by both the kernel's TaggedMesh
 * (number[]) and the worker's TransferMesh (typed arrays). */
export interface MeshView {
  vertices: ArrayLike<number>;
  indices: ArrayLike<number>;
  faceGroups: ReadonlyArray<{ normal: V3; centroid: V3; start: number; count: number }>;
  edges: ReadonlyArray<{ faceNormals: readonly [V3, V3]; midpoint: V3; positions: ArrayLike<number> }>;
}

export interface InspectedFace {
  index: number;
  normal: V3;
  centroid: V3;
  /** Face area in mm². */
  area: number;
  kind: "planar" | "curved";
}
export interface InspectedEdge {
  index: number;
  faceNormals: readonly [V3, V3];
  midpoint: V3;
  /** Polyline length in mm. */
  length: number;
  straight: boolean;
}

export interface Inspection {
  faces: InspectedFace[];
  edges: InspectedEdge[];
  /** Index-aligned to `faces` — the concrete ref to write into a dress-up. */
  faceRefs: FaceRef[];
  /** Index-aligned to `edges`. */
  edgeRefs: EdgeRef[];
  /** Human/model-readable enumeration (mm units). */
  text: string;
}

const PLANAR_DOT_TOL = Math.cos((5 * Math.PI) / 180); // within 5° ⇒ planar
const STRAIGHT_TOL = 1e-4; // perpendicular deviation / length below this ⇒ straight

function v(vertices: ArrayLike<number>, i: number): V3 {
  return [vertices[i * 3]!, vertices[i * 3 + 1]!, vertices[i * 3 + 2]!];
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Sum the triangle areas of a face group (m²), and whether every triangle's normal
 * aligns with the face normal (planar) or not (curved, e.g. a cylinder). */
function faceAreaAndKind(mesh: MeshView, g: { normal: V3; start: number; count: number }): { area: number; kind: "planar" | "curved" } {
  let area = 0;
  let planar = true;
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = v(mesh.vertices, mesh.indices[k]!);
    const b = v(mesh.vertices, mesh.indices[k + 1]!);
    const c = v(mesh.vertices, mesh.indices[k + 2]!);
    const triN = cross(sub(b, a), sub(c, a));
    area += 0.5 * len(triN);
    if (planar && dot(norm(triN), norm(g.normal)) < PLANAR_DOT_TOL) planar = false;
  }
  return { area, kind: planar ? "planar" : "curved" };
}

/** Polyline length (m) + straightness of a flat [x,y,z,…] edge. */
function edgeLengthAndStraight(positions: ArrayLike<number>): { length: number; straight: boolean } {
  const n = Math.floor(positions.length / 3);
  if (n < 2) return { length: 0, straight: true };
  let length = 0;
  for (let i = 1; i < n; i++) {
    length += len(sub(v(positions, i), v(positions, i - 1)));
  }
  if (n === 2) return { length, straight: true };
  const start = v(positions, 0);
  const end = v(positions, n - 1);
  const axis = sub(end, start);
  const axisLen = len(axis) || 1;
  let maxPerp = 0;
  for (let i = 1; i < n - 1; i++) {
    const rel = sub(v(positions, i), start);
    const perp = len(cross(rel, axis)) / axisLen; // distance from the chord
    if (perp > maxPerp) maxPerp = perp;
  }
  return { length, straight: maxPerp / axisLen < STRAIGHT_TOL };
}

const mm3 = (p: V3): string => `(${toMm(p[0]).toFixed(1)}, ${toMm(p[1]).toFixed(1)}, ${toMm(p[2]).toFixed(1)})`;
const dir3 = (p: V3): string => `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)})`;

/** Inspect a tagged mesh into faces/edges + index-aligned refs + a text summary. */
export function inspectMesh(mesh: MeshView): Inspection {
  const faces: InspectedFace[] = [];
  const faceRefs: FaceRef[] = [];
  mesh.faceGroups.forEach((g, index) => {
    const { area, kind } = faceAreaAndKind(mesh, g);
    faces.push({ index, normal: g.normal, centroid: g.centroid, area: area * 1e6, kind });
    faceRefs.push({ normal: g.normal, centroid: g.centroid });
  });

  const edges: InspectedEdge[] = [];
  const edgeRefs: EdgeRef[] = [];
  mesh.edges.forEach((e, index) => {
    const { length, straight } = edgeLengthAndStraight(e.positions);
    edges.push({ index, faceNormals: e.faceNormals, midpoint: e.midpoint, length: toMm(length), straight });
    edgeRefs.push({ faceNormals: e.faceNormals, midpoint: e.midpoint });
  });

  const faceLines = faces.map(
    (f) => `Face ${f.index}: ${f.kind}, normal ${dir3(f.normal)}, centroid ${mm3(f.centroid)} mm, area ${f.area.toFixed(1)} mm²`,
  );
  const edgeLines = edges.map(
    (e) => `Edge ${e.index}: ${e.straight ? "straight" : "curved"}, midpoint ${mm3(e.midpoint)} mm, length ${e.length.toFixed(1)} mm, between faces ${dir3(e.faceNormals[0])}/${dir3(e.faceNormals[1])}`,
  );
  const text = [`Faces (${faces.length}):`, ...faceLines, `Edges (${edges.length}):`, ...edgeLines].join("\n");

  return { faces, edges, faceRefs, edgeRefs, text };
}

/** Build the current document and inspect it. `probe` returns the mesh (the app
 * wraps GeometryClient.build; tests build via rebuildTagged with real OCCT). */
export type MeshProbe = (doc: CadDocument) => Promise<MeshView | null>;

export interface InspectGeometryResult extends Partial<Inspection> {
  status: "ok" | "empty";
  text: string;
}

export async function inspectGeometry(doc: CadDocument, probe: MeshProbe): Promise<InspectGeometryResult> {
  const mesh = await probe(doc);
  if (!mesh || mesh.faceGroups.length === 0) {
    return { status: "empty", text: "There is no built geometry to inspect yet." };
  }
  return { status: "ok", ...inspectMesh(mesh) };
}
