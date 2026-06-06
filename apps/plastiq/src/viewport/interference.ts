// Interference / clash detection (FR-33 family): which assembly instances overlap.
// This is a BOUNDING-BOX (broad-phase) check — conservative for rotated or non-box
// parts (the world AABB encloses the shape) and exact for axis-aligned boxes.
// Exact B-rep solid intersection (OCCT boolean per pair) is a heavier follow-up.
// SceneController supplies each instance's world AABB; this pairs up the overlaps.

export interface InstanceBox {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
}

export interface Clash {
  a: string;
  b: string;
}

/**
 * Pairs of instances whose world AABBs overlap by more than `tol` on EVERY axis,
 * so merely touching faces (zero penetration) don't register as a clash. O(n²)
 * over the instance count — fine for assembly-scale counts.
 */
export function findClashes(boxes: readonly InstanceBox[], tol = 1e-6): Clash[] {
  const clashes: Clash[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const penetrates =
        Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) > tol &&
        Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]) > tol &&
        Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]) > tol;
      if (penetrates) clashes.push({ a: a.id, b: b.id });
    }
  }
  return clashes;
}
