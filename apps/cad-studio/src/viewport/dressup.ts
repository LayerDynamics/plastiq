// Selection-driven dress-up features (SPEC-5 FR-30). Turns the current typed
// selection (transient pick ids) + the build's persistent-ref lookup (FR-16)
// into the feature `data` a fillet/chamfer/shell/draft stores, so the dress-up
// re-resolves to the same edges/faces after an upstream parameter rebuild.
//
// Pure functions over picks + SelectionRefs, so they unit-test in Node.

import type { EdgeRef, FaceRef, SpinePath } from "@plastiq/cad";
import type { NewFeature } from "../store/store.js";
import type { SelectionRefs } from "../store/store.js";
import type { Pick } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";

/** Persistent EdgeRefs for the currently picked edges (skips unresolved ids). */
export function edgeRefsFromPicks(picks: readonly Pick[], refs: SelectionRefs): EdgeRef[] {
  return picks
    .filter((p) => p.kind === "edge")
    .map((p) => refs.edges[p.id])
    .filter(Boolean) as EdgeRef[];
}

/** Persistent FaceRefs for the currently picked faces (skips unresolved ids). */
export function faceRefsFromPicks(picks: readonly Pick[], refs: SelectionRefs): FaceRef[] {
  return picks
    .filter((p) => p.kind === "face")
    .map((p) => refs.faces[p.id])
    .filter(Boolean) as FaceRef[];
}

/** A fillet feature on the picked edges (constant radius), or null if none. */
export function filletFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  radius: number,
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  return { type: "fillet", params: { radius }, data: { edges } };
}

/** A chamfer feature on the picked edges (symmetric setback), or null if none. */
export function chamferFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  distance: number,
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  return { type: "chamfer", params: { distance }, data: { edges } };
}

/** A shell feature opening the picked faces to a wall thickness, or null. */
export function shellFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  thickness: number,
): NewFeature | null {
  const faces = faceRefsFromPicks(picks, refs);
  if (faces.length === 0) return null;
  return { type: "shell", params: { thickness }, data: { faces } };
}

/** A two-sided extrude pad of the active profile (`height` up + `back` down). */
export function extrudeTwoSidedFeature(height: number, back: number): NewFeature {
  return { type: "extrude", params: { height, back } };
}

/** An extrude of the active profile up to the first picked face (FR-29), or null. */
export function extrudeToFaceFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
): NewFeature | null {
  const face = faceRefsFromPicks(picks, refs)[0];
  if (!face) return null;
  return { type: "extrude", params: {}, data: { toFace: face } };
}

/** An extrude of the active profile along the first picked edge's direction. */
export function extrudeAlongEdgeFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  height: number,
): NewFeature | null {
  const edge = edgeRefsFromPicks(picks, refs)[0];
  if (!edge) return null;
  return { type: "extrude", params: { height }, data: { directionEdge: edge } };
}

/**
 * A boolean of the base body with a SECOND modelled body (FR-31). `tools` is the
 * feature subtree that builds the tool body (e.g. a sketch + extrude, or a box);
 * it is given stable ids so the rebuild can evaluate it independently.
 */
export function booleanBodyFeature(
  op: "union" | "subtract" | "intersect",
  tools: NewFeature[],
): NewFeature {
  const toolFeatures = tools.map((t, i) => ({ ...t, id: `tool${i}` }));
  return { type: "boolean", params: {}, data: { op, toolFeatures } };
}

/** A loft through ≥2 section profiles, each at its own height z (FR-32). */
export function loftFeature(
  sections: { profile: Profile; z: number }[],
  ruled = false,
): NewFeature | null {
  if (sections.length < 2) return null;
  return { type: "loft", data: { sections, ruled } };
}

/** A sweep of `profile` along a polyline/arc `path` (FR-32). */
export function sweepFeature(profile: Profile, path: SpinePath): NewFeature {
  return { type: "sweep", data: { profile, path } };
}

/** A draft feature tapering the first picked face about the base plane, or null. */
export function draftFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  angle: number,
): NewFeature | null {
  const faces = faceRefsFromPicks(picks, refs);
  const face = faces[0];
  if (!face) return null;
  // Default neutral plane = the world base (z=0, +Z), pulling along +Z; suitable
  // for tapering the upright faces of a part for mold release.
  return {
    type: "draft",
    params: { angle },
    data: {
      face,
      pull: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
    },
  };
}
