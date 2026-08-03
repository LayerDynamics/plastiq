// Selection-driven dress-up features (SPEC-5 FR-30). Turns the current typed
// selection (transient pick ids) + the build's persistent-ref lookup (FR-16)
// into the feature `data` a fillet/chamfer/shell/draft stores, so the dress-up
// re-resolves to the same edges/faces after an upstream parameter rebuild.
//
// Pure functions over picks + SelectionRefs, so they unit-test in Node.

import type { EdgeRef, FaceRef, HelixSpec, SpinePath, VertexRef } from "@plastiq/cad";
import type { NewFeature } from "../store/store.js";
import type { SelectionRefs } from "../store/store.js";
import type { EditorFeature, Pick } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";
import { isProfile } from "../sketch/profile.js";
import type { SketchPlaneSpec } from "../sketch/model.js";

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

/** Persistent VertexRefs for the currently picked corners (R12; skips unresolved ids). */
export function vertexRefsFromPicks(picks: readonly Pick[], refs: SelectionRefs): VertexRef[] {
  const verts = refs.vertices ?? {};
  return picks
    .filter((p) => p.kind === "vertex")
    .map((p) => verts[p.id])
    .filter(Boolean) as VertexRef[];
}

/** A fillet feature on the picked edges (constant or variable radius via endRadius), or null. */
export function filletFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  radius: number,
  endRadius?: number,
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  const params: Record<string, number> = { radius };
  // C8: radius2 is the rebuild/UI param name for variable end radius.
  if (endRadius !== undefined && Number.isFinite(endRadius)) params["radius2"] = endRadius;
  return { type: "fillet", params, data: { edges } };
}

/** A chamfer on the picked edges; optional distance2 + face for two-distance chamfer (C8). */
export function chamferFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  distance: number,
  opts?: { distance2?: number; face?: FaceRef },
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  const params: Record<string, number> = { distance };
  if (opts?.distance2 !== undefined && Number.isFinite(opts.distance2)) {
    params["distance2"] = opts.distance2;
  }
  const data: Record<string, unknown> = { edges };
  if (opts?.face) data["face"] = opts.face;
  return { type: "chamfer", params, data };
}

/** A shell feature opening the picked faces to a wall thickness, or null.
 * `direction: "outward"` grows walls out (T12 / G13). */
export function shellFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  thickness: number,
  direction: "inward" | "outward" = "inward",
): NewFeature | null {
  const faces = faceRefsFromPicks(picks, refs);
  if (faces.length === 0) return null;
  return {
    type: "shell",
    params: { thickness },
    data: direction === "outward" ? { faces, direction: "outward" } : { faces },
  };
}

/** A two-sided extrude pad of the active profile (`height` up + `back` down).
 * `op: "join"` so a pad on an existing body adds material (C1); rebuild also
 * joins by default when `op` is unset and a solid exists. */
export function extrudeTwoSidedFeature(height: number, back: number): NewFeature {
  return { type: "extrude", params: { height, back }, data: { op: "join" } };
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
  return { type: "extrude", params: { height }, data: { directionEdge: edge, op: "join" } };
}

/** Revolve the active profile about the first picked edge (C2). Angle in SI radians. */
export function revolveAboutEdgeFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  angle: number,
): NewFeature | null {
  const edge = edgeRefsFromPicks(picks, refs)[0];
  if (!edge) return null;
  return {
    type: "revolve",
    params: { angle },
    data: { axisEdge: edge, op: "join" },
  };
}

/** Two-sided pocket cut (`depth` + `back`) of the active profile (G5 / T04). */
export function cutTwoSidedFeature(depth: number, back: number): NewFeature {
  return { type: "cut", params: { depth, back } };
}

/** Cut the active profile along the first picked edge's direction (T04). */
export function cutAlongEdgeFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  depth: number,
): NewFeature | null {
  const edge = edgeRefsFromPicks(picks, refs)[0];
  if (!edge) return null;
  return { type: "cut", params: { depth }, data: { directionEdge: edge } };
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

/** One loft section: profile + either legacy `z` (world-XY offset) or a full plane. */
export type LoftSectionInput = {
  profile: Profile;
  z?: number;
  plane?: SketchPlaneSpec;
};

/** A loft through ≥2 section profiles (FR-32). Prefer `plane` per section (C4/G6). */
export function loftFeature(sections: LoftSectionInput[], ruled = false): NewFeature | null {
  if (sections.length < 2) return null;
  return { type: "loft", data: { sections, ruled } };
}

/**
 * Build a loft from finished sketch features by id (T08). Each sketch must carry
 * a buildable profile; its stored plane is used as the section plane.
 */
export function loftFromSketchFeatures(
  features: readonly EditorFeature[],
  sketchIds: readonly string[],
  ruled = false,
): NewFeature | null {
  if (sketchIds.length < 2) return null;
  const sections: LoftSectionInput[] = [];
  for (const id of sketchIds) {
    const sk = features.find((f) => f.id === id && f.type === "sketch" && !f.suppressed);
    if (!sk) return null;
    const prof = sk.data?.["profile"] as Profile | undefined;
    if (!isProfile(prof)) return null;
    const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
    sections.push(plane ? { profile: prof, plane } : { profile: prof, z: 0 });
  }
  return loftFeature(sections, ruled);
}

/** §14 open-shell loft through ≥2 section profiles (surfaceLoft kernel op). */
export function surfaceLoftFeature(sections: LoftSectionInput[], ruled = false): NewFeature | null {
  if (sections.length < 2) return null;
  return { type: "surfaceLoft", data: { sections, ruled } };
}

/**
 * §14 surface loft from finished sketch features (same section extraction as
 * {@link loftFromSketchFeatures}, different feature type).
 */
export function surfaceLoftFromSketchFeatures(
  features: readonly EditorFeature[],
  sketchIds: readonly string[],
  ruled = false,
): NewFeature | null {
  if (sketchIds.length < 2) return null;
  const sections: LoftSectionInput[] = [];
  for (const id of sketchIds) {
    const sk = features.find((f) => f.id === id && f.type === "sketch" && !f.suppressed);
    if (!sk) return null;
    const prof = sk.data?.["profile"] as Profile | undefined;
    if (!isProfile(prof)) return null;
    const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
    sections.push(plane ? { profile: prof, plane } : { profile: prof, z: 0 });
  }
  return surfaceLoftFeature(sections, ruled);
}

/** A sweep of `profile` along a polyline path (FR-32). Optional `plane` places
 * the profile (defaults to world-XY at rebuild when omitted). */
export function sweepFeature(
  profile: Profile,
  path: SpinePath,
  plane?: SketchPlaneSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature {
  return {
    type: "sweep",
    data: {
      profile,
      path,
      ...(plane ? { plane } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.transition ? { transition: opts.transition } : {}),
    },
  };
}

/**
 * Sweep from a sketch feature (profile + plane) along a world polyline (T09).
 */
export function sweepFromSketchFeature(
  features: readonly EditorFeature[],
  sketchId: string,
  path: SpinePath,
  opts?: { mode?: string; transition?: string },
): NewFeature | null {
  const sk = features.find((f) => f.id === sketchId && f.type === "sketch" && !f.suppressed);
  if (!sk) return null;
  const prof = sk.data?.["profile"] as Profile | undefined;
  if (!isProfile(prof)) return null;
  const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
  return sweepFeature(prof, path, plane, opts);
}

/**
 * §13.2 helical sweep: profile + `data.helix` (kernel helix() → wire → sweepAlongWire).
 * Not a separate feature type — same "sweep" rebuild case as polyline / pathEdges.
 */
export function helixSweepFeature(
  profile: Profile,
  helix: HelixSpec,
  plane?: SketchPlaneSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature {
  return {
    type: "sweep",
    data: {
      profile,
      helix: {
        radius: helix.radius,
        pitch: helix.pitch,
        turns: helix.turns,
        handedness: helix.handedness,
        ...(helix.taperAngle !== undefined ? { taperAngle: helix.taperAngle } : {}),
      },
      ...(plane ? { plane } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.transition ? { transition: opts.transition } : {}),
    },
  };
}

/**
 * Helical sweep from a sketch feature's profile (§13.2).
 *
 * The helix is about +Z and starts at (radius, 0, 0) with tangent ≈ +Y, so the
 * profile is placed on XZ (normal +Y) — perpendicular to that start tangent —
 * regardless of the sketch's original plane. A circle profile is recentered on
 * the helix start so MakePipeShell locates the section on the spine.
 */
export function helixSweepFromSketchFeature(
  features: readonly EditorFeature[],
  sketchId: string,
  helix: HelixSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature | null {
  const sk = features.find((f) => f.id === sketchId && f.type === "sketch" && !f.suppressed);
  if (!sk) return null;
  const prof = sk.data?.["profile"] as Profile | undefined;
  if (!isProfile(prof)) return null;
  // XZ plane: U→X, V→Z. Circle at (helix.radius, 0) → world (r, 0, 0).
  const plane: SketchPlaneSpec = { base: "XZ", offset: 0 };
  const profile: Profile =
    prof.kind === "circle"
      ? { kind: "circle", center: [helix.radius, prof.center[1]], radius: prof.radius }
      : prof;
  return helixSweepFeature(profile, helix, plane, opts);
}

/** §14 open pipe shell of `profile` along a path (surfaceSweep kernel op). */
export function surfaceSweepFeature(
  profile: Profile,
  path: SpinePath,
  plane?: SketchPlaneSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature {
  return {
    type: "surfaceSweep",
    data: {
      profile,
      path,
      ...(plane ? { plane } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.transition ? { transition: opts.transition } : {}),
    },
  };
}

/** §14 surface sweep from a sketch feature along a world polyline. */
export function surfaceSweepFromSketchFeature(
  features: readonly EditorFeature[],
  sketchId: string,
  path: SpinePath,
  opts?: { mode?: string; transition?: string },
): NewFeature | null {
  const sk = features.find((f) => f.id === sketchId && f.type === "sketch" && !f.suppressed);
  if (!sk) return null;
  const prof = sk.data?.["profile"] as Profile | undefined;
  if (!isProfile(prof)) return null;
  const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
  return surfaceSweepFeature(prof, path, plane, opts);
}

/** §14 surface sweep along picked model edges (persistent EdgeRefs). */
export function surfaceSweepAlongEdgesFeature(
  profile: Profile,
  pathEdges: readonly EdgeRef[],
  plane?: SketchPlaneSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature {
  return {
    type: "surfaceSweep",
    data: {
      profile,
      pathEdges,
      ...(plane ? { plane } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.transition ? { transition: opts.transition } : {}),
    },
  };
}

/** §14 surface sweep from sketch along currently picked edges, or null. */
export function surfaceSweepFromSketchAlongPickedEdges(
  features: readonly EditorFeature[],
  sketchId: string,
  picks: readonly Pick[],
  refs: SelectionRefs,
  opts?: { mode?: string; transition?: string },
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  const sk = features.find((f) => f.id === sketchId && f.type === "sketch" && !f.suppressed);
  if (!sk) return null;
  const prof = sk.data?.["profile"] as Profile | undefined;
  if (!isProfile(prof)) return null;
  const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
  return surfaceSweepAlongEdgesFeature(prof, edges, plane, opts);
}

/**
 * A sweep of `profile` along a spine of edges PICKED ON THE MODEL (FR-32).
 * Stores persistent EdgeRefs rather than baked points, so the rebuild
 * re-resolves the spine against the current body — the pipe follows its edges
 * when an upstream parameter moves them. Same contract as the `directionEdge` /
 * `axisEdge` overrides on extrude/revolve.
 */
export function sweepAlongEdgesFeature(
  profile: Profile,
  pathEdges: readonly EdgeRef[],
  plane?: SketchPlaneSpec,
  opts?: { mode?: string; transition?: string },
): NewFeature {
  return {
    type: "sweep",
    data: {
      profile,
      pathEdges,
      ...(plane ? { plane } : {}),
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.transition ? { transition: opts.transition } : {}),
    },
  };
}

/**
 * Sweep a sketch's profile along the currently picked edge chain, or null when
 * the sketch has no profile / no edges are picked (the caller falls back to a
 * typed path).
 */
export function sweepFromSketchAlongPickedEdges(
  features: readonly EditorFeature[],
  sketchId: string,
  picks: readonly Pick[],
  refs: SelectionRefs,
  opts?: { mode?: string; transition?: string },
): NewFeature | null {
  const edges = edgeRefsFromPicks(picks, refs);
  if (edges.length === 0) return null;
  const sk = features.find((f) => f.id === sketchId && f.type === "sketch" && !f.suppressed);
  if (!sk) return null;
  const prof = sk.data?.["profile"] as Profile | undefined;
  if (!isProfile(prof)) return null;
  const plane = sk.data?.["plane"] as SketchPlaneSpec | undefined;
  return sweepAlongEdgesFeature(prof, edges, plane, opts);
}

/** A draft feature tapering the picked face(s) about a neutral plane, or null.
 * Multi-face selection is stored as `data.faces` (G9); a single face also sets
 * `data.face` for back-compat with older documents.
 * When a face ref carries a normal, pull/neutral follow that face (T12 / C6). */
export function draftFeature(
  picks: readonly Pick[],
  refs: SelectionRefs,
  angle: number,
): NewFeature | null {
  const faces = faceRefsFromPicks(picks, refs);
  if (faces.length === 0) return null;
  const n = faces[0]!.normal;
  const pull: [number, number, number] = [n[0], n[1], n[2]];
  // Neutral plane through face centroid if known, else world origin with face normal.
  const c = faces[0]!.centroid;
  const neutralOrigin: [number, number, number] = c
    ? [c[0], c[1], c[2]]
    : [0, 0, 0];
  const neutralNormal: [number, number, number] = [n[0], n[1], n[2]];
  return {
    type: "draft",
    params: { angle },
    data: {
      face: faces[0],
      faces,
      pull,
      neutralOrigin,
      neutralNormal,
    },
  };
}
