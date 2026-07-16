// SPEC-6 R3.1 — the inspect_geometry tool (FR-11, FR-12).
//
// Builds the current part and serializes its tagged mesh into a structured,
// text-friendly enumeration of faces and edges (with normals, positions, real
// computed area/length, a planar/cylindrical/curved face classification per
// FR-11, and a straight hint per edge) — no rendered image needed (spec §6.3).
// The model references faces/edges by INDEX; `faceRefs`/`edgeRefs` are
// index-aligned so the client writes the concrete FaceRef/EdgeRef into a
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
  /** FR-11 classification: flat, a circular cylinder patch (a hole wall, a rod's
   * lateral face, a fillet blend), or any other non-planar surface. */
  kind: "planar" | "cylindrical" | "curved";
  /** Cylinder radius in mm — present only for kind "cylindrical". */
  radius?: number;
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
const CYL_AXIS_DOT_TOL = Math.sin((5 * Math.PI) / 180); // triangle normals within 5° of ⊥ the axis
const CYL_RADIUS_RTOL = 0.02; // vertex radial scatter ≤ 2% of the radius ⇒ constant radius
const DEGENERATE_EPS = 1e-12; // below this a direction/determinant carries no information

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

/** Estimate a cylinder axis from a curved face's triangle normals: on a circular
 * cylinder every normal is perpendicular to the axis, so any non-parallel pair's cross
 * product points along it. Accumulate sign-aligned pair crosses (robust against
 * tessellation noise); null when the normals carry no rotational spread. */
function cylinderAxis(normals: V3[]): V3 | null {
  const n0 = normals[0];
  if (!n0) return null;
  let axis: V3 = [0, 0, 0];
  for (let i = 1; i < normals.length; i++) {
    const c = cross(n0, normals[i]!);
    if (len(c) < 1e-6) continue; // (anti)parallel to n0 — no axis information
    const aligned: V3 = dot(c, axis) < 0 ? [-c[0], -c[1], -c[2]] : c;
    axis = [axis[0] + aligned[0], axis[1] + aligned[1], axis[2] + aligned[2]];
  }
  return len(axis) < 1e-6 ? null : norm(axis);
}

/** Least-squares (Kåsa) circle fit on mean-centred 2D points. Returns the centre (in
 * the centred frame) + radius, or null for a degenerate (collinear) point set. */
function fitCircle(us: number[], vs: number[]): { cu: number; cv: number; r: number } | null {
  const n = us.length;
  let suu = 0, suv = 0, svv = 0, suq = 0, svq = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const u = us[i]!;
    const w = vs[i]!;
    const q = u * u + w * w;
    suu += u * u;
    suv += u * w;
    svv += w * w;
    suq += u * q;
    svq += w * q;
    sq += q;
  }
  // Centred data ⇒ Σu = Σv = 0 and the 3×3 Kåsa system decouples: C = -Σq/n and a 2×2
  // solve for [A, B] in (u² + v² + Au + Bv + C) ≈ 0.
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < DEGENERATE_EPS * (suu + svv) * (suu + svv) || suu + svv < DEGENERATE_EPS) return null;
  const a = (-suq * svv + svq * suv) / det;
  const b = (-svq * suu + suq * suv) / det;
  const c = -sq / n;
  const cu = -a / 2;
  const cv = -b / 2;
  const r2 = cu * cu + cv * cv - c;
  if (!(r2 > 0) || !Number.isFinite(r2)) return null;
  return { cu, cv, r: Math.sqrt(r2) };
}

/** Test a non-planar face group for a circular cylinder: (1) its triangle normals share
 * one axis they are all perpendicular to (rules out spheres/cones/freeform), and (2) its
 * vertices sit at a constant radius from that axis — verified by a least-squares circle
 * fit of the vertices projected along the axis (rules out non-circular extrusions).
 * Returns the radius in SI metres, or null when the face is not cylindrical. */
function cylinderRadius(mesh: MeshView, g: { start: number; count: number }, normals: V3[]): number | null {
  const axis = cylinderAxis(normals);
  if (!axis) return null;
  for (const n of normals) {
    if (Math.abs(dot(n, axis)) > CYL_AXIS_DOT_TOL) return null;
  }

  // Project the group's (unique) vertices onto the plane perpendicular to the axis.
  const ref: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(axis, ref));
  const e2 = cross(axis, e1);
  const seen = new Set<number>();
  const us: number[] = [];
  const vs: number[] = [];
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = mesh.indices[k]!;
    if (seen.has(vi)) continue;
    seen.add(vi);
    const p = v(mesh.vertices, vi);
    us.push(dot(p, e1));
    vs.push(dot(p, e2));
  }
  if (us.length < 3) return null;
  // Mean-centre for numerical conditioning (SI coordinates are small; 4th-power sums
  // of raw values would be poorly scaled).
  const mu = us.reduce((s, x) => s + x, 0) / us.length;
  const mv = vs.reduce((s, x) => s + x, 0) / vs.length;
  const cu = us.map((x) => x - mu);
  const cv = vs.map((x) => x - mv);

  const fit = fitCircle(cu, cv);
  if (!fit) return null;
  // Tessellation vertices lie ON the true surface, so a real cylinder's vertices sit at
  // the fitted radius to within numerical noise; a blend/freeform surface scatters.
  let maxDev = 0;
  for (let i = 0; i < cu.length; i++) {
    const d = Math.hypot(cu[i]! - fit.cu, cv[i]! - fit.cv);
    maxDev = Math.max(maxDev, Math.abs(d - fit.r));
  }
  return maxDev <= CYL_RADIUS_RTOL * fit.r ? fit.r : null;
}

/** Sum the triangle areas of a face group (m²) and classify it (FR-11): planar when
 * every triangle normal aligns with the face normal, cylindrical when the normals and
 * vertices match a circular cylinder (see cylinderRadius), otherwise curved. */
function faceAreaAndKind(
  mesh: MeshView,
  g: { normal: V3; start: number; count: number },
): { area: number; kind: "planar" | "cylindrical" | "curved"; radius?: number } {
  let area = 0;
  let planar = true;
  const groupN = norm(g.normal);
  const normals: V3[] = [];
  for (let k = g.start; k < g.start + g.count; k += 3) {
    const a = v(mesh.vertices, mesh.indices[k]!);
    const b = v(mesh.vertices, mesh.indices[k + 1]!);
    const c = v(mesh.vertices, mesh.indices[k + 2]!);
    const triN = cross(sub(b, a), sub(c, a));
    const l = len(triN);
    area += 0.5 * l;
    if (l < DEGENERATE_EPS) continue; // sliver triangle — no usable direction
    const n: V3 = [triN[0] / l, triN[1] / l, triN[2] / l];
    normals.push(n);
    if (planar && dot(n, groupN) < PLANAR_DOT_TOL) planar = false;
  }
  if (planar) return { area, kind: "planar" };
  const radius = cylinderRadius(mesh, g, normals);
  return radius != null ? { area, kind: "cylindrical", radius } : { area, kind: "curved" };
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
    const { area, kind, radius } = faceAreaAndKind(mesh, g);
    faces.push({
      index,
      normal: g.normal,
      centroid: g.centroid,
      area: area * 1e6,
      kind,
      ...(radius != null ? { radius: toMm(radius) } : {}),
    });
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
    (f) =>
      `Face ${f.index}: ${f.kind}${f.kind === "cylindrical" && f.radius != null ? ` (radius ${f.radius.toFixed(1)} mm)` : ""}, normal ${dir3(f.normal)}, centroid ${mm3(f.centroid)} mm, area ${f.area.toFixed(1)} mm²`,
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
