// Typed 3D picking (SPEC-5 FR-8): turn a viewport ray into a B-rep entity pick.
// The keystone mapping is `raycast triangle → render group → faceId`: a hit's
// `faceIndex` (the n-th triangle) lands in exactly one per-face group's index
// range, and that group's position gives the faceId via the mesh's
// `userData.faceIds`. Edges/vertices carry their id directly on the picked
// object/point. The mapping is pure (no Raycaster), so it is unit-tested.

import * as THREE from "three";
import type { Pick, SelectionMode } from "../store/types.js";
import type { BuiltPart } from "./buildMesh.js";

/**
 * Map a raycast triangle index to its B-rep faceId via the mesh groups.
 * Keyed off the group `start/count` ranges only — NOT `materialIndex`, which
 * every group shares until highlighted and which mutates during selection.
 *
 * Takes the THREE.Mesh rather than a BuiltPart so it also serves hits on an
 * ASSEMBLY INSTANCE, whose group is built from the same tagged mesh but is not
 * the base part (mate picking, M4.2).
 */
export function faceIdOfMesh(mesh: THREE.Mesh, faceIndex: number): number | null {
  const faceIds = mesh.userData["faceIds"] as number[] | undefined;
  if (!faceIds) return null;
  const offset = faceIndex * 3; // index-buffer offset of this triangle
  const groups = mesh.geometry.groups;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (offset >= g.start && offset < g.start + g.count) return faceIds[i] ?? null;
  }
  return null;
}

/** Map a raycast triangle index on the base part to its B-rep faceId. */
export function faceIdAt(part: BuiltPart, faceIndex: number): number | null {
  return faceIdOfMesh(part.mesh, faceIndex);
}

/** A rubber-band rectangle in NDC space (−1..1, y up). */
export interface NdcRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Build a normalised NDC rect from two corner points (any order). */
export function ndcRect(a: { x: number; y: number }, b: { x: number; y: number }): NdcRect {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/** Ids of the candidates whose projected NDC point falls inside `rect` (FR-10). */
export function boxSelect(
  rect: NdcRect,
  candidates: readonly { id: number; x: number; y: number }[],
): number[] {
  return candidates
    .filter((c) => c.x >= rect.minX && c.x <= rect.maxX && c.y >= rect.minY && c.y <= rect.maxY)
    .map((c) => c.id);
}

/** Pixel tolerances for the thin line/point targets, mapped to world units. */
export interface PickThresholds {
  /** Edge line pick radius (world units). */
  line: number;
  /** Vertex point pick radius (world units). */
  point: number;
}

const DEFAULT_THRESHOLDS: PickThresholds = { line: 0.0015, point: 0.0025 };

export class Picker {
  private readonly ray = new THREE.Raycaster();

  constructor(thresholds: PickThresholds = DEFAULT_THRESHOLDS) {
    this.ray.params.Line = { threshold: thresholds.line };
    this.ray.params.Points = { threshold: thresholds.point };
  }

  /**
   * Resolve the front-most pickable entity under `ndc` (normalized device
   * coords, −1..1) for the current selection `mode`. Returns null on a miss.
   * `body` mode picks the whole part via any face hit.
   */
  pick(
    part: BuiltPart,
    ndc: THREE.Vector2,
    camera: THREE.Camera,
    mode: SelectionMode,
  ): Pick | null {
    this.ray.setFromCamera(ndc, camera);

    if (mode === "face" || mode === "body") {
      const hit = this.ray.intersectObject(part.mesh, false)[0];
      if (hit?.faceIndex != null) {
        const id = faceIdAt(part, hit.faceIndex);
        if (id != null) return { kind: mode, id };
      }
      return null;
    }

    if (mode === "edge") {
      const hit = this.ray.intersectObjects(part.edges, false)[0];
      const edgeId = hit?.object.userData["edgeId"];
      if (typeof edgeId === "number") return { kind: "edge", id: edgeId };
      return null;
    }

    // vertex
    if (!part.vertexPoints) return null;
    const hit = this.ray.intersectObject(part.vertexPoints, false)[0];
    if (hit?.index != null) {
      const ids = part.vertexPoints.userData["vertexIds"] as number[] | undefined;
      const id = ids?.[hit.index];
      if (typeof id === "number") return { kind: "vertex", id };
    }
    return null;
  }

  /**
   * Nearest world point on the part under `ndc` (surface, edge, or corner) —
   * the measure tool's "what did I click in space" query (FR-13). Snaps to a
   * corner/edge hit when one is closer than the surface hit.
   */
  pickPoint(part: BuiltPart, ndc: THREE.Vector2, camera: THREE.Camera): THREE.Vector3 | null {
    this.ray.setFromCamera(ndc, camera);
    const targets: THREE.Object3D[] = [part.mesh, ...part.edges];
    if (part.vertexPoints) targets.push(part.vertexPoints);
    const hit = this.ray.intersectObjects(targets, false)[0];
    return hit ? hit.point.clone() : null;
  }
}
