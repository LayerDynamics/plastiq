// Tagged mesh → three.js objects (SPEC-5 M0.5, FR-7/FR-14). Turns the worker's
// TransferMesh into a renderable group:
//   • one BufferGeometry with **per-face groups** sharing a [base, hover,
//     selected] MultiMaterial — a face is highlighted by swapping its group's
//     materialIndex, no re-tessellation (the M1 picking technique);
//   • each B-rep edge as its own pickable LineSegments, sharing three swap
//     materials so any one edge can be tinted independently;
//   • the B-rep corners as one Points cloud with per-point vertex colours.
//
// Pure object construction (no WebGL context), so it is unit-testable in Node.

import * as THREE from "three";
import type { TransferMesh } from "../worker/protocol.js";
import type { MeshBody } from "../mesh/meshBody.js";
import { meshSegments } from "../mesh/editMesh.js";

/** Material slots shared by every face group / edge line; highlight = swap. */
export const FACE_MATERIAL = { base: 0, hover: 1, selected: 2 } as const;

/** Base/hover/selected colours, shared by edges and vertices. */
export const ENTITY_COLOR = { base: 0x10141c, hover: 0x4ea1ff, selected: 0xffa23a } as const;

function overlayLineMaterial(color: number, overlay = false): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    depthTest: !overlay,
    depthWrite: false,
  });
}

export interface BuiltPart {
  /** The whole part (solid mesh + edge lines + corner points), added to the scene. */
  group: THREE.Group;
  /** The solid mesh (per-face groups; userData.faceIds[groupIndex] = faceId). */
  mesh: THREE.Mesh;
  /** Edge lines, each with userData.edgeId. */
  edges: THREE.LineSegments[];
  /** Shared [base, hover, selected] line materials; highlight swaps line.material. */
  edgeMaterials: THREE.LineBasicMaterial[];
  /** B-rep corner markers (userData.vertexIds[pointIndex] = vertexId), or null. */
  vertexPoints: THREE.Points | null;
}

function faceMaterials(): THREE.Material[] {
  return [
    new THREE.MeshStandardMaterial({ color: 0xd6dbe6, metalness: 0.1, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: ENTITY_COLOR.hover, metalness: 0.1, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({
      color: ENTITY_COLOR.selected,
      metalness: 0.1,
      roughness: 0.5,
    }),
  ];
}

/** Build the renderable part from a worker TransferMesh. */
export function buildPart(transfer: TransferMesh): BuiltPart {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(transfer.vertices, 3));
  geom.setIndex(new THREE.BufferAttribute(transfer.indices, 1));
  geom.computeVertexNormals();

  // One render group per B-rep face, all pointing at the base material slot.
  // groupIndex (insertion order) ↔ faceId, recorded for pick resolution (M1).
  const faceIds: number[] = [];
  for (const g of transfer.faceGroups) {
    geom.addGroup(g.start, g.count, FACE_MATERIAL.base);
    faceIds.push(g.faceId);
  }

  const mesh = new THREE.Mesh(geom, faceMaterials());
  mesh.userData["faceIds"] = faceIds;
  mesh.name = "part-solid";

  // Three shared line materials; a highlighted edge points at hover/selected.
  const edgeMaterials = [
    overlayLineMaterial(ENTITY_COLOR.base),
    overlayLineMaterial(ENTITY_COLOR.hover, true),
    overlayLineMaterial(ENTITY_COLOR.selected, true),
  ];
  const edges: THREE.LineSegments[] = [];
  for (const e of transfer.edges) {
    // A polyline [p0,p1,p2,…] → segment pairs (p0p1, p1p2, …) for LineSegments.
    const pts = e.positions;
    const segCount = pts.length / 3 - 1;
    const seg = new Float32Array(Math.max(segCount, 0) * 6);
    for (let i = 0; i < segCount; i++) {
      seg.set(pts.subarray(i * 3, i * 3 + 3), i * 6);
      seg.set(pts.subarray(i * 3 + 3, i * 3 + 6), i * 6 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(seg, 3));
    const line = new THREE.LineSegments(g, edgeMaterials[FACE_MATERIAL.base]);
    line.userData["edgeId"] = e.edgeId;
    line.userData["faceIds"] = e.faceIds;
    line.renderOrder = 2;
    line.name = `edge-${e.edgeId}`;
    edges.push(line);
  }

  // B-rep corners as a single Points cloud with per-point colours, so any one
  // corner can be highlighted independently (vertexColors); base colour to start.
  let vertexPoints: THREE.Points | null = null;
  if (transfer.vertexPositions.length > 0) {
    const vg = new THREE.BufferGeometry();
    vg.setAttribute("position", new THREE.BufferAttribute(transfer.vertexPositions, 3));
    const n = transfer.vertexIds.length;
    const colors = new Float32Array(n * 3);
    const base = new THREE.Color(ENTITY_COLOR.base);
    for (let i = 0; i < n; i++) base.toArray(colors, i * 3);
    vg.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const vmat = new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: false,
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
    });
    vertexPoints = new THREE.Points(vg, vmat);
    vertexPoints.userData["vertexIds"] = [...transfer.vertexIds];
    vertexPoints.renderOrder = 3;
    vertexPoints.name = "part-vertices";
  }

  const group = new THREE.Group();
  group.name = "part";
  group.add(mesh);
  for (const line of edges) group.add(line);
  if (vertexPoints) group.add(vertexPoints);
  return { group, mesh, edges, edgeMaterials, vertexPoints };
}

/** A renderable generated/imported mesh body (the creative path; SPEC-6 R4.2). */
export interface BuiltMeshBody {
  /** The triangle-soup mesh, ready to add to the scene. */
  mesh: THREE.Mesh;
  /** Selectable mesh edge/standalone segments, each tagged with local segment index. */
  edges: THREE.LineSegments[];
  /** Mesh vertices as independently selectable points. */
  vertexPoints: THREE.Points;
  edgeMaterials: THREE.LineBasicMaterial[];
  /** Free its geometry + material. */
  dispose(): void;
}

/** Fallback surface colour for a mesh body that carries no material. */
const MESH_BODY_COLOR = 0xb8c0d0;

function meshBodyMaterials(m: MeshBody["material"]): THREE.Material[] {
  const opacity = m?.opacity ?? 1;
  const common = {
    metalness: m?.metalness ?? 0.1,
    roughness: m?.roughness ?? 0.7,
    opacity,
    transparent: opacity < 1,
  };
  return [
    new THREE.MeshStandardMaterial({ ...common, color: m?.color ?? MESH_BODY_COLOR }),
    new THREE.MeshStandardMaterial({ ...common, color: ENTITY_COLOR.hover }),
    new THREE.MeshStandardMaterial({ ...common, color: ENTITY_COLOR.selected }),
  ];
}

/** Build a renderable THREE.Mesh from a MeshBody triangle soup (SPEC-6 R4.2).
 * A mesh document renders these directly on the main thread — no OCCT and no
 * worker round-trip (decision 24 / R4 refinement 2). Supplied per-vertex normals
 * are reused as-is; otherwise smooth vertex normals are computed for lighting.
 * Mesh documents are still non-B-rep, but their raw vertices and triangle/standalone
 * segments are exposed as directly editable mesh entities. */
export function buildMeshBody(body: MeshBody): BuiltMeshBody {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(body.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(body.indices, 1));
  if (body.normals && body.normals.length === body.positions.length) {
    geom.setAttribute("normal", new THREE.BufferAttribute(body.normals, 3));
  } else {
    geom.computeVertexNormals();
  }

  for (let i = 0; i < body.indices.length; i += 3) geom.addGroup(i, 3, FACE_MATERIAL.base);
  const material = meshBodyMaterials(body.material);

  const mesh = new THREE.Mesh(geom, material);
  mesh.renderOrder = 0;
  mesh.name = "mesh-body";
  mesh.userData["faceIds"] = Array.from({ length: Math.floor(body.indices.length / 3) }, (_, i) => i);
  const edgeMaterials = [
    overlayLineMaterial(ENTITY_COLOR.base),
    overlayLineMaterial(ENTITY_COLOR.hover, true),
    overlayLineMaterial(ENTITY_COLOR.selected, true),
  ];
  const edges = meshSegments(body).map((segment, index) => {
    const points = new Float32Array(6);
    points.set(body.positions.subarray(segment.a * 3, segment.a * 3 + 3), 0);
    points.set(body.positions.subarray(segment.b * 3, segment.b * 3 + 3), 3);
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute("position", new THREE.BufferAttribute(points, 3));
    const line = new THREE.LineSegments(edgeGeom, edgeMaterials[FACE_MATERIAL.base]);
    line.userData["edgeId"] = index;
    line.renderOrder = 2;
    line.name = `mesh-edge-${index}`;
    return line;
  });

  const pointGeom = new THREE.BufferGeometry();
  pointGeom.setAttribute("position", new THREE.BufferAttribute(body.positions, 3));
  const vertexCount = Math.floor(body.positions.length / 3);
  const colors = new Float32Array(vertexCount * 3);
  const base = new THREE.Color(ENTITY_COLOR.base);
  for (let i = 0; i < vertexCount; i++) base.toArray(colors, i * 3);
  pointGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const pointMat = new THREE.PointsMaterial({
    size: 7,
    sizeAttenuation: false,
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
  });
  const vertexPoints = new THREE.Points(pointGeom, pointMat);
  vertexPoints.userData["vertexIds"] = Array.from({ length: vertexCount }, (_, i) => i);
  vertexPoints.renderOrder = 3;
  vertexPoints.name = "mesh-vertices";

  return {
    mesh,
    edges,
    vertexPoints,
    edgeMaterials,
    dispose() {
      geom.dispose();
      for (const m of material) m.dispose();
      for (const line of edges) line.geometry.dispose();
      for (const m of edgeMaterials) m.dispose();
      pointGeom.dispose();
      pointMat.dispose();
    },
  };
}

/** Free the GPU/CPU buffers of a built part. */
export function disposePart(part: BuiltPart): void {
  part.mesh.geometry.dispose();
  const mats = Array.isArray(part.mesh.material) ? part.mesh.material : [part.mesh.material];
  for (const m of mats) m.dispose();
  for (const line of part.edges) line.geometry.dispose();
  for (const m of part.edgeMaterials) m.dispose();
  if (part.vertexPoints) {
    part.vertexPoints.geometry.dispose();
    const vm = part.vertexPoints.material;
    (Array.isArray(vm) ? vm : [vm]).forEach((m) => m.dispose());
  }
}
