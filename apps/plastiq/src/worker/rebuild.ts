// Feature-tree → solid evaluation (SPEC-5). Replays an editor document's feature
// list through the @plastiq/cad kernel into one Solid, then tags its tessellation
// (FR-6) for the viewport. This is the editor's deterministic "rebuild"; it runs
// inside the geometry worker (FR-5) but is a pure function of (oc, document) so
// it is unit-tested in Node with real OCCT.
//
// Feature types are added per milestone: M0 = box + sketch/extrude (enough to
// render); M2 adds fillet/chamfer/shell/draft/boolean/pattern; M3 feeds richer
// sketches. An unsupported type throws a typed per-feature error (the tree shows
// it as an errored feature, SPEC-4 FR-24 semantics).

import {
  chamferWithHistory,
  circularPattern,
  cut,
  draftWithHistory,
  hole,
  type HoleKind,
  type HoleSpec,
  thicken,
  surfaceLoft,
  surfaceSweep,
  surfaceSweepAlongWire,
  surfaceRevolve,
  surfaceFromPoints,
  offsetSurface,
  sew,
  solidify,
  patch,
  trimSurface,
  extrude,
  extrudeToFace,
  nativePrism,
  linearForm,
  filletWithHistory,
  describeOcctError,
  resolveEdgeDirection,
  resolveEdgeAxis,
  resolveEdgeRef,
  buildWireFromEdges,
  sweepAlongWire,
  helix,
  type HelixSpec,
  type HelixHandedness,
  importStep,
  importIges,
  intersect,
  linearPattern,
  patternAlongPath,
  split,
  sectionCurves,
  loft,
  makeBox,
  makeBoxAt,
  makeCylinder,
  makeSphere,
  makeCone,
  makeTorus,
  makeCompound,
  bodiesOf,
  type AxisPlacement,
  mirror,
  offsetPlane,
  faceDatumPlane,
  resolveFaceRef,
  resolveVertexRef,
  resolveSelector,
  isSelector,
  planeXY,
  revolve,
  sweep,
  type SweepOptions,
  type DatumPlane,
  type SpinePath,
  rotate,
  scale,
  shellWithHistory,
  Sketch,
  subtract,
  tessellateTagged,
  translate,
  union,
  unionAll,
  releaseBooleanHistory,
  faceIdRemap,
  FACE_REMOVED,
  surfacesMatch,
  type ShellOptions,
  type EdgeRef,
  type FaceRef,
  type VertexRef,
  type Occt,
  type Solid,
  type TaggedMesh,
  type TessellateOptions,
  type OwnedShapeHistory,
  type BooleanResult,
  // Freeform (§15): pure-TS NURBS → sample grid → surfaceFromPoints face Solid.
  evaluate as evaluateFreeform,
  domain as freeformDomain,
  makeNurbsSurface,
  validateSurface,
  planeSurface,
  cylinderSurface,
  sphereSurface,
  type NurbsSurface,
} from "@plastiq/cad";
import type { TopoDS_Edge } from "opencascade.js";
import type { CadDocument, EditorFeature } from "../store/types.js";
import { extractProfile, isProfile, type Profile } from "../sketch/profile.js";
import { resolveSketchPlane } from "./sketchPlane.js";
import { isFaceSketchPlane, type SketchModel, type SketchPlaneSpec } from "../sketch/model.js";
import { evalExpr } from "../store/paramExpr.js";

/** A 3-vector (the kernel's Vec3 shape; not re-exported from the root). */
type Vec3 = [number, number, number];

/**
 * R6: make the document's global params LIVE. A feature's `exprs[key]` is an
 * arithmetic expression over `doc.params`; evaluate each at rebuild entry and
 * OVERRIDE `params[key]` with the result, so editing one global parameter drives
 * every feature that references it. Returns `f` untouched when it carries no
 * exprs (the overwhelming common case), so there is zero cost for plain features.
 * A bad expression / unknown identifier throws and is caught as a feature error.
 */
function resolveFeatureExprs(f: EditorFeature, params: Record<string, number>): EditorFeature {
  if (!f.exprs) return f;
  const resolved: Record<string, number> = { ...(f.params ?? {}) };
  for (const [key, expr] of Object.entries(f.exprs)) {
    resolved[key] = evalExpr(expr, params);
  }
  return { ...f, params: resolved };
}

function num(f: EditorFeature, key: string): number {
  const v = f.params?.[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`feature '${f.id}' (${f.type}): missing/invalid numeric param '${key}'`);
  }
  return v;
}

/** Optional numeric param with a default (for two-sided / axis options). */
function opt(f: EditorFeature, key: string, fallback: number): number {
  const v = f.params?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Parse `data.helix` for a sweep feature into a kernel {@link HelixSpec}.
 * Returns null when absent (caller falls through to path / pathEdges). Throws
 * when present but incomplete so a half-authored helix fails loudly.
 */
function parseHelixSpec(raw: unknown, featureId: string): HelixSpec | null {
  if (raw == null) return null;
  if (typeof raw !== "object") {
    throw new Error(`feature '${featureId}' (sweep): data.helix must be an object`);
  }
  const h = raw as Record<string, unknown>;
  const radius = Number(h["radius"]);
  const pitch = Number(h["pitch"]);
  const turns = Number(h["turns"]);
  const handRaw = h["handedness"];
  const handedness: HelixHandedness | null =
    handRaw === "right" || handRaw === "left" ? handRaw : null;
  if (
    !Number.isFinite(radius) ||
    !Number.isFinite(pitch) ||
    !Number.isFinite(turns) ||
    !handedness
  ) {
    throw new Error(
      `feature '${featureId}' (sweep): data.helix needs radius, pitch, turns, and handedness ("right"|"left")`,
    );
  }
  const taperRaw = h["taperAngle"];
  const taperAngle = taperRaw === undefined || taperRaw === null ? undefined : Number(taperRaw);
  if (taperAngle !== undefined && !Number.isFinite(taperAngle)) {
    throw new Error(
      `feature '${featureId}' (sweep): data.helix.taperAngle must be a finite number`,
    );
  }
  return {
    radius,
    pitch,
    turns,
    handedness,
    ...(taperAngle !== undefined ? { taperAngle } : {}),
  };
}

/**
 * Build a kernel Sketch on the given datum plane (default XY) from a derived
 * editor profile. A circle becomes a true curved edge (real cylinder on extrude);
 * a loop becomes its line/arc segment chain.
 *
 * The profile is an explicit closed loop (its last segment lands back on
 * `start`). The kernel auto-closes an open chain with a straight edge, so a
 * trailing *line* back to start is dropped (the kernel re-adds it); a trailing
 * *arc* is kept so the closing edge stays curved.
 */
function profileSketch(profile: Profile, plane: DatumPlane = planeXY()): Sketch {
  if (profile.kind === "circle") {
    return Sketch.circle(plane, profile.center[0], profile.center[1], profile.radius);
  }
  if (profile.kind === "ellipse") {
    return Sketch.ellipse(plane, profile.center, profile.focus1, profile.minorRadius);
  }
  const sk = new Sketch(plane);
  const [su, sv] = profile.start;
  sk.lineTo(su, sv);
  profile.segments.forEach((seg, i) => {
    const isLast = i === profile.segments.length - 1;
    const closesOnStart = seg.to[0] === su && seg.to[1] === sv;
    if (seg.kind === "line") {
      if (isLast && closesOnStart) return; // kernel auto-closes with this line
      sk.lineTo(seg.to[0], seg.to[1]);
    } else if (seg.kind === "arc") {
      sk.arcTo(seg.through[0], seg.through[1], seg.to[0], seg.to[1]);
    } else {
      sk.splineTo(seg.through);
    }
  });
  return sk;
}

/** Cut a pad/pocket solid's holes (T11/C5/§2.7 — profile.holes). A hole is a full
 * circle or an inner LOOP of line/arc/spline segments (a rectangular/shaped hole),
 * so the plate-with-a-hole case no longer breaks the whole sketch. Each hole is
 * extruded through the same range as the pad and subtracted. */
function cutProfileHoles(
  oc: Occt,
  body: Solid,
  profile: Profile,
  plane: DatumPlane,
  height: number,
  opts: { back?: number; direction?: Vec3 },
  featureId: string,
): Solid {
  if (profile.kind !== "loop" || !profile.holes?.length) return body;
  let acc = body;
  for (const h of profile.holes) {
    const holeSk =
      h.kind === "circle"
        ? Sketch.circle(plane, h.center[0], h.center[1], h.radius)
        : profileSketch({ kind: "loop", start: h.start, segments: h.segments }, plane);
    const tool = extrude(oc, holeSk, height, { back: opts.back ?? 0, direction: opts.direction });
    try {
      const r = subtract(oc, acc, tool);
      if (acc !== body) acc.delete();
      if (!r.ok) throw new Error(`feature '${featureId}' (profile hole): ${r.error}`);
      releaseBooleanHistory(r);
      acc = r.solid;
    } finally {
      tool.delete();
    }
  }
  return acc;
}

/**
 * Fuse pattern copies into one independent solid (the caller still owns + deletes
 * the input `copies`). Always returns a fresh solid, even for a single copy.
 *
 * Delegates to the kernel's N-ary fuse: this used to fold the copies PAIRWISE,
 * re-running OCCT's intersection machinery against the ever-growing accumulator
 * once per copy (§2.2). One call hands OCCT every operand at once — a single
 * intersection pass, and no intermediate accumulator that can land in a
 * degenerate state the next fuse then fails on.
 */
function fusePatternCopies(oc: Occt, copies: readonly Solid[], featureId: string): Solid {
  if (copies.length === 0) throw new Error(`feature '${featureId}': pattern produced no copies`);
  const r = unionAll(oc, copies);
  if (!r.ok) throw new Error(`feature '${featureId}' (pattern union): ${r.error}`);
  releaseBooleanHistory(r);
  return r.solid;
}

/**
 * Build a DatumPlane from origin + normal (+ optional xAxis). Used by split/section
 * when the AI/ribbon stores a pure plane tool rather than a solid knife.
 */
function planeFromOriginNormal(origin: Vec3, normal: Vec3, xAxis?: Vec3, op = "plane"): DatumPlane {
  const nLen = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(nLen > 0)) throw new Error(`${op}: plane normal must be a non-zero vector`);
  const n: Vec3 = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];
  let x: Vec3;
  if (xAxis) {
    const xLen = Math.hypot(xAxis[0], xAxis[1], xAxis[2]);
    if (!(xLen > 0)) throw new Error(`${op}: plane xAxis must be a non-zero vector`);
    x = [xAxis[0] / xLen, xAxis[1] / xLen, xAxis[2] / xLen];
  } else {
    // Orthonormal completion: pick a helper not parallel to n, then x = helper × n.
    const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cx: Vec3 = [
      helper[1] * n[2] - helper[2] * n[1],
      helper[2] * n[0] - helper[0] * n[2],
      helper[0] * n[1] - helper[1] * n[0],
    ];
    const cLen = Math.hypot(cx[0], cx[1], cx[2]);
    x = [cx[0] / cLen, cx[1] / cLen, cx[2] / cLen];
  }
  return { origin, normal: n, xAxis: x };
}

/** Read data.plane { origin, normal, xAxis? } into a DatumPlane. */
function planeFromFeatureData(
  data: Record<string, unknown> | undefined,
  featureId: string,
  op: string,
): DatumPlane {
  const plane = data?.["plane"] as
    | { origin?: unknown; normal?: unknown; xAxis?: unknown }
    | undefined;
  if (!plane || !Array.isArray(plane.origin) || plane.origin.length !== 3) {
    throw new Error(`feature '${featureId}' (${op}): data.plane.origin must be a 3-vector`);
  }
  if (!Array.isArray(plane.normal) || plane.normal.length !== 3) {
    throw new Error(`feature '${featureId}' (${op}): data.plane.normal must be a 3-vector`);
  }
  const origin: Vec3 = [Number(plane.origin[0]), Number(plane.origin[1]), Number(plane.origin[2])];
  const normal: Vec3 = [Number(plane.normal[0]), Number(plane.normal[1]), Number(plane.normal[2])];
  let xAxis: Vec3 | undefined;
  if (Array.isArray(plane.xAxis) && plane.xAxis.length === 3) {
    xAxis = [Number(plane.xAxis[0]), Number(plane.xAxis[1]), Number(plane.xAxis[2])];
  }
  return planeFromOriginNormal(origin, normal, xAxis, `feature '${featureId}' (${op})`);
}

/**
 * Pattern solid along EdgeRefs resolved on the current body (same spine contract
 * as sweep pathEdges — re-derived every rebuild so the pattern follows edges).
 */
function pathPatternAlongPickedEdges(
  oc: Occt,
  base: Solid,
  seed: Solid,
  pathEdges: readonly EdgeRef[],
  count: number,
  align: boolean,
  featureId: string,
): Solid[] {
  const edges: TopoDS_Edge[] = [];
  try {
    for (const ref of pathEdges) {
      const e = resolveEdgeRef(oc, base, ref);
      if (!e) {
        throw new Error(
          `feature '${featureId}' (pathPattern): ${pathEdges.length - edges.length} of ${pathEdges.length} path edge(s) did not resolve on the current body`,
        );
      }
      edges.push(e);
    }
    // patternAlongPath does not take ownership of a Wire spine — free it after.
    const wire = buildWireFromEdges(oc, edges);
    try {
      return patternAlongPath(oc, seed, wire, count, align ? { align: true } : undefined);
    } finally {
      wire.delete();
    }
  } finally {
    for (const e of edges) e.delete();
  }
}

/** Feature types that ADD material by merging into the current body. Used to
 * spot a join that changed nothing (§13.8 P0); `cut`/`intersect`/`new` are
 * excluded because they legitimately shrink, reshape, or stand apart. */
const ADDITIVE_TYPES: ReadonlySet<string> = new Set([
  "extrude",
  "rib",
  "revolve",
  "loft",
  "sweep",
  "box",
  "cylinder",
  "sphere",
  "cone",
  "torus",
]);

function joinsIntoCurrentBody(f: EditorFeature): boolean {
  if (!ADDITIVE_TYPES.has(f.type)) return false;
  const op = f.data?.["op"];
  return op === undefined || op === "join";
}

/**
 * "New body" (§2.4): keep everything built so far and add `fresh` alongside it as
 * a SEPARATE body, instead of destroying the prior geometry.
 *
 * This is the whole of §2.4's user-visible defect: `op: "new"` used to install the
 * fresh solid over the accumulator, and the accumulator's `replace()` deletes what
 * it replaces — so "New body" deleted your part. A compound keeps both: no boolean
 * runs, so nothing is welded and each body keeps its own faces, edges and volume,
 * while the rest of the pipeline still sees one `Solid` (tessellation, booleans,
 * dress-up, mass properties and STEP/IGES/glTF export all accept a compound —
 * verified against real OCCT, not assumed).
 *
 * Consumes `fresh` (the compound holds its own reference to its shape). `prior`
 * stays owned by the caller — the accumulator's `replace()` frees it, which is
 * safe for the same reason: OCCT shapes are refcounted, so the compound outlives
 * the wrapper it was built from.
 */
function newBody(oc: Occt, prior: Solid, fresh: Solid): Solid {
  try {
    return makeCompound(oc, [prior, fresh]);
  } finally {
    fresh.delete();
  }
}

/**
 * Combine a freshly-built primitive with the current body per `data.op` (§4.11).
 *
 * Mirrors the extrude convention — join-by-default once a body exists, explicit
 * `"new"` starts a SEPARATE body (§2.4) — and adds `"cut"`/`"intersect"`, which is
 * what makes the round primitives immediately useful: subtracting a cylinder IS a
 * bore, with the sketcher (§2.6/§2.7) out of the loop entirely.
 *
 * Takes ownership of `tool`: it is always freed, and the returned solid is the
 * one the caller should install.
 */
/**
 * R8/K4: set true when a boolean's `UnifySameDomain` degrade swallowed a failure,
 * leaving a FRAGMENTED result (the state the boolean module header says breaks
 * coplanar face selection). The evaluator loop reads + resets this around each
 * feature build to lower it to a per-feature WARNING. Module-level is safe: the
 * geometry worker runs exactly ONE synchronous rebuild per request (stateless per
 * request), so there is never a concurrent evaluator to race it.
 */
let lastCombineDegraded = false;

function combinePrimitive(oc: Occt, current: Solid | null, tool: Solid, f: EditorFeature): Solid {
  const op = f.data?.["op"];
  if (!current) return tool;
  if (op === "new") return newBody(oc, current, tool);
  try {
    const r =
      op === "cut"
        ? subtract(oc, current, tool)
        : op === "intersect"
          ? intersect(oc, current, tool)
          : union(oc, current, tool);
    if (!r.ok) throw new Error(`feature '${f.id}' (${f.type} ${String(op ?? "join")}): ${r.error}`);
    if (r.degraded) lastCombineDegraded = true;
    // Solid-only consumer: free boolean history so every primitive join/cut does
    // not leak a Handle_BRepTools_History in the long-lived worker (§13.1).
    releaseBooleanHistory(r);
    return r.solid;
  } finally {
    tool.delete();
  }
}

/**
 * §13.1 — after a history-capable boolean, derive oldFaceId→newFaceId and rewrite
 * FaceRef disambiguators (centroid/normal/surface) on later features so a pick that
 * shared an analytic surface with another face re-anchors without a centroid
 * tie-break against the PRE-boolean body.
 *
 * `base` is the pre-boolean solid (still live); `result` is the boolean solid.
 * Always frees `history` (even when tessellate/remap throws).
 */
function threadShapeHistory(
  oc: Occt,
  doc: CadDocument,
  featureId: string,
  base: Solid,
  result: Solid,
  history: OwnedShapeHistory,
): void {
  try {
    const prevMesh = tessellateTagged(oc, base);
    const curMesh = tessellateTagged(oc, result);
    const map = faceIdRemap(oc, prevMesh, base, curMesh, result, history);
    rewriteFaceRefsAfterRemap(doc.features, featureId, map, prevMesh, curMesh);
  } finally {
    history.delete();
  }
}

/** Thread and consume a dress-up maker history; free the new solid if remap fails. */
function finishHistoryResult(
  oc: Occt,
  doc: CadDocument,
  featureId: string,
  base: Solid,
  result: { solid: Solid; history?: OwnedShapeHistory },
): Solid {
  if (!result.history) return result.solid;
  try {
    threadShapeHistory(oc, doc, featureId, base, result.solid, result.history);
    return result.solid;
  } catch (error) {
    result.solid.delete();
    throw error;
  }
}

/** Sq distance between two 3-vectors. */
function dist2(a: readonly number[], b: readonly number[]): number {
  const dx = a[0]! - b[0]!;
  const dy = a[1]! - b[1]!;
  const dz = a[2]! - b[2]!;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Map a stored FaceRef onto a prev-mesh faceId (surface + closest centroid), then
 * rewrite its disambiguators from the remapped current face. Mutates feature data
 * in place — same objects the store holds — so the next rebuild's resolveFaceRef
 * sees the post-boolean centroid without relying on a pre-boolean tie-break.
 */
function rewriteFaceRefsAfterRemap(
  features: readonly EditorFeature[],
  afterFeatureId: string,
  map: Map<number, number>,
  prevMesh: TaggedMesh,
  curMesh: TaggedMesh,
): void {
  let past = false;
  for (const f of features) {
    if (!past) {
      if (f.id === afterFeatureId) past = true;
      continue;
    }
    const data = f.data;
    if (!data) continue;
    if (Array.isArray(data["faces"])) {
      data["faces"] = (data["faces"] as FaceRef[]).map((ref) =>
        rewriteOneFaceRef(ref, map, prevMesh, curMesh),
      );
    }
    if (data["face"] && typeof data["face"] === "object") {
      data["face"] = rewriteOneFaceRef(data["face"] as FaceRef, map, prevMesh, curMesh);
    }
  }
}

function rewriteOneFaceRef(
  ref: FaceRef,
  map: Map<number, number>,
  prevMesh: TaggedMesh,
  curMesh: TaggedMesh,
): FaceRef {
  let oldId = -1;
  let bestD = Infinity;
  for (const g of prevMesh.faceGroups) {
    if (ref.surface) {
      if (!surfacesMatch(ref.surface, g.surface)) continue;
    } else {
      // Legacy ref without surface: require roughly matching outward normal.
      const dn =
        ref.normal[0]! * g.normal[0]! +
        ref.normal[1]! * g.normal[1]! +
        ref.normal[2]! * g.normal[2]!;
      if (dn < 0.9) continue;
    }
    if (ref.centroid) {
      const d = dist2(ref.centroid, g.centroid);
      if (d < bestD) {
        bestD = d;
        oldId = g.faceId;
      }
    } else if (oldId < 0) {
      oldId = g.faceId;
    }
  }
  if (oldId < 0) return ref;
  const newId = map.get(oldId);
  if (newId == null || newId === FACE_REMOVED) return ref;
  const ng = curMesh.faceGroups.find((g) => g.faceId === newId);
  if (!ng) return ref;
  return {
    normal: [ng.normal[0], ng.normal[1], ng.normal[2]],
    centroid: [ng.centroid[0], ng.centroid[1], ng.centroid[2]],
    surface: ng.surface,
  };
}

/** Run a binary boolean and thread §13.1 history when present. */
function runDocumentBoolean(
  oc: Occt,
  doc: CadDocument,
  featureId: string,
  base: Solid,
  tool: Solid,
  op: string,
): Solid {
  const r: BooleanResult =
    op === "subtract"
      ? subtract(oc, base, tool)
      : op === "intersect"
        ? intersect(oc, base, tool)
        : union(oc, base, tool);
  if (!r.ok) throw new Error(`feature '${featureId}' (boolean ${op}): ${r.error}`);
  if (r.degraded) lastCombineDegraded = true;
  if (r.history) {
    threadShapeHistory(oc, doc, featureId, base, r.solid, r.history);
  }
  return r.solid;
}

/** A round primitive's placement: origin defaults to the world origin, axis to +Z. */
function primitivePlacement(f: EditorFeature): AxisPlacement & { angle?: number } {
  const angle = f.params?.["angle"];
  return {
    origin: [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)],
    axis: [opt(f, "ax", 0), opt(f, "ay", 0), opt(f, "az", 1)],
    // A full sweep is the ABSENCE of an angle, not 2π: passing 2π selects OCCT's
    // partial-sweep ctor, which builds a seam the full-sweep one does not.
    ...(typeof angle === "number" && Number.isFinite(angle) && angle < 2 * Math.PI
      ? { angle }
      : {}),
  };
}

/** Dress-up edge selection: explicit EdgeRef[] if given, else resolve a selector
 * predicate against the current solid (SPEC-6 R3.2, FR-13/FR-14). */
function dressEdges(oc: Occt, base: Solid, f: EditorFeature): EdgeRef[] {
  const explicit = (f.data?.["edges"] ?? []) as EdgeRef[];
  if (explicit.length > 0) return explicit;
  const sel = f.data?.["selector"];
  return isSelector(sel) ? resolveSelector(oc, base, sel).edges : [];
}

/** Dress-up face selection: explicit FaceRef[] if given, else resolve a selector. */
function dressFaces(oc: Occt, base: Solid, f: EditorFeature): FaceRef[] {
  const explicit = (f.data?.["faces"] ?? []) as FaceRef[];
  if (explicit.length > 0) return explicit;
  const sel = f.data?.["selector"];
  return isSelector(sel) ? resolveSelector(oc, base, sel).faces : [];
}

/**
 * Sweep `sk` along a spine picked on the model: re-resolve each persistent
 * EdgeRef against the CURRENT body, wire the edges into a spine, and pipe the
 * profile along it. This is what keeps an edge-driven sweep parametric — the
 * spine is re-derived every rebuild instead of being baked to points at
 * creation, so the pipe follows its edges when upstream parameters move them.
 *
 * An unresolved edge fails LOUDLY (same contract as the dress-ups): silently
 * sweeping along the remaining edges would produce a quietly wrong solid.
 */
function sweepAlongPickedEdges(
  oc: Occt,
  base: Solid | null,
  sk: Sketch,
  pathEdges: readonly EdgeRef[],
  featureId: string,
  opts: SweepOptions | undefined,
): Solid {
  if (!base) throw new Error(`feature '${featureId}' (sweep): no body for the path edges`);
  const edges: TopoDS_Edge[] = [];
  try {
    for (const ref of pathEdges) {
      const e = resolveEdgeRef(oc, base, ref);
      if (!e) {
        throw new Error(
          `feature '${featureId}' (sweep): ${pathEdges.length - edges.length} of ${pathEdges.length} path edge(s) did not resolve on the current body`,
        );
      }
      edges.push(e);
    }
    // sweepAlongWire takes ownership of the wire (frees it on success and throw).
    return sweepAlongWire(oc, sk, buildWireFromEdges(oc, edges), opts);
  } finally {
    for (const e of edges) e.delete();
  }
}

/** §14 surface-sweep along picked edges — same spine re-resolve as solid sweep,
 * but {@link surfaceSweepAlongWire} (no MakeSolid). */
function surfaceSweepAlongPickedEdges(
  oc: Occt,
  base: Solid | null,
  sk: Sketch,
  pathEdges: readonly EdgeRef[],
  featureId: string,
  opts: SweepOptions | undefined,
): Solid {
  if (!base) throw new Error(`feature '${featureId}' (surfaceSweep): no body for the path edges`);
  const edges: TopoDS_Edge[] = [];
  try {
    for (const ref of pathEdges) {
      const e = resolveEdgeRef(oc, base, ref);
      if (!e) {
        throw new Error(
          `feature '${featureId}' (surfaceSweep): ${pathEdges.length - edges.length} of ${pathEdges.length} path edge(s) did not resolve on the current body`,
        );
      }
      edges.push(e);
    }
    return surfaceSweepAlongWire(oc, sk, buildWireFromEdges(oc, edges), opts);
  } finally {
    for (const e of edges) e.delete();
  }
}

/**
 * Evaluate `doc`'s feature tree into a single Solid (or null if it produces no
 * geometry). Throws on the first unrecoverable feature error; the caller
 * (worker/tree) attributes it to the offending feature.
 */
type ActiveSketch = {
  profile: Profile;
  plane: DatumPlane;
  /** True when the plane came from a MODEL FACE rather than a base datum. A face
   * plane's normal points OUT of the body it was taken from, which is what tells
   * a cut which way the material actually lies (§13.8 P0). */
  onFace: boolean;
  /** Original zero-offset support ref, retained for BRepFeat native local forms. */
  support?: FaceRef;
};

/** Resolve the sketch profile for extrude/cut/revolve (C3): prefer
 * `data.sketchId`, then the first `deps` entry that names a known sketch, then
 * the most recent sketch (legacy last-wins). */
/**
 * The sketch a profile feature (extrude/cut/revolve/sweep/boolean) consumes.
 *
 * Resolution order, and the §2.10.3 fix — an EXPLICIT binding must resolve or the
 * feature FAILS (returns null → the caller errors it loudly), rather than silently
 * rebinding to an unrelated sketch:
 *
 *  1. `data.sketchId` (the authoritative AI/panel binding): if set, it MUST name a
 *     currently-active sketch — a stale id (its sketch deleted/suppressed/renamed)
 *     returns null, never a fallback.
 *  2. `deps`: the first dep that is an active sketch wins. If none is active but a
 *     dep named a sketch that is now DELETED (gone from the doc) or SUPPRESSED (a
 *     sketch feature that did not build), the feature lost its bound sketch → null.
 *  3. Otherwise (the feature named no specific sketch — most ribbon-created
 *     features carry no deps) fall back to the last-built sketch. This is the only
 *     legitimate use of the last-wins fallback.
 */
function sketchForFeature(
  f: { id: string; deps?: readonly string[]; data?: Record<string, unknown> },
  sketches: Map<string, ActiveSketch>,
  lastSketch: ActiveSketch | null,
  allFeatureIds: ReadonlySet<string>,
  sketchFeatureIds: ReadonlySet<string>,
): ActiveSketch | null {
  const sketchId =
    typeof f.data?.["sketchId"] === "string" ? (f.data["sketchId"] as string) : undefined;
  // An explicit sketchId is the binding — resolve it or FAIL (§2.10.3). It also
  // takes precedence over deps (the AI path overrides the panel's deps select).
  if (sketchId !== undefined) return sketches.get(sketchId) ?? null;
  if (f.deps && f.deps.length > 0) {
    for (const id of f.deps) {
      const s = sketches.get(id);
      if (s) return s;
    }
    // No dep resolved to an ACTIVE sketch. If a dep named a sketch that is now
    // deleted or suppressed, this feature lost its bound sketch — do NOT rebind.
    const lostSketchDep = f.deps.some((id) => !allFeatureIds.has(id) || sketchFeatureIds.has(id));
    if (lostSketchDep) return null;
  }
  return lastSketch;
}

/** Per-feature outcome of a rebuild pass (SPEC-5 FR-24 timeline semantics).
 *
 * `"warning"` is a feature that BUILT but changed nothing the user can see —
 * today, a join that added no material because the new shape lies entirely
 * inside the existing body (§13.8's P0). It is deliberately not an error: the
 * geometry is valid and the timeline continues, but reporting it "ok" is how
 * "I did the operation and nothing happened" became the product's signature
 * complaint. */
export interface FeatureBuildStatus {
  readonly featureId: string;
  readonly status: "ok" | "error" | "suppressed" | "warning";
  /** Present only when `status === "error"`; always names the feature. */
  readonly message?: string;
}

/** Result of an isolating rebuild: the geometry that survived + every feature's fate. */
export interface IsolatedBuild {
  readonly solid: Solid | null;
  readonly statuses: FeatureBuildStatus[];
}

/**
 * Evaluate a document's feature tree.
 *
 * `isolate` picks the failure contract:
 *  - `false` (fail-fast) — the first bad feature throws. Correct for INTERNAL
 *    sub-builds (a boolean's tool subtree, a pattern's tool features) and the
 *    headless CLI, where a half-built tool must not silently become geometry.
 *  - `true` (isolating) — a bad feature is recorded and SKIPPED, and the
 *    previous solid passes through untouched, so one impossible fillet no
 *    longer blanks the whole model. This is Fusion/Onshape timeline semantics
 *    and is what the interactive editor uses.
 */
function evaluateDocument(oc: Occt, doc: CadDocument, isolate: boolean): IsolatedBuild {
  const statuses: FeatureBuildStatus[] = [];
  let solid: Solid | null = null;
  // Sketch registry by feature id (C3) + last-wins fallback for documents without deps.
  const sketches = new Map<string, ActiveSketch>();
  let lastSketch: ActiveSketch | null = null;
  // Every feature id, and every SKETCH feature id (incl. suppressed) — so
  // sketchForFeature can tell a deleted/suppressed sketch dependency (fail) from a
  // legitimately non-sketch dep (fall back), §2.10.3.
  const allFeatureIds: ReadonlySet<string> = new Set(doc.features.map((x) => x.id));
  const sketchFeatureIds: ReadonlySet<string> = new Set(
    doc.features.filter((x) => x.type === "sketch").map((x) => x.id),
  );

  const replace = (next: Solid): void => {
    solid?.delete();
    solid = next;
  };
  /**
   * Read the accumulator. Every assignment to `solid` happens inside `replace`,
   * and TypeScript's control-flow analysis does not look into closures — so it
   * pins `solid` to the `null` of its initializer and narrows guarded reads to
   * `never`. Reading through an accessor whose DECLARED return type is
   * `Solid | null` restores the truth that a body may exist by this point.
   */
  const currentSolid = (): Solid | null => solid;

  for (const f of doc.features) {
    if (f.suppressed) {
      statuses.push({ featureId: f.id, status: "suppressed" });
      continue;
    }
    try {
      // §13.8 P0: a join that lands entirely INSIDE the current body adds no
      // material, so the rebuild reports "ok" while the viewport shows exactly
      // what it showed before — the first thing a new user does (sketch on XY,
      // extrude up into the starter box) hits precisely this. A union can only
      // ever grow or preserve volume, so "volume unchanged" is a sound test for
      // "this union added nothing". Measured once per additive feature that has
      // something to merge into; other feature types skip the mass-properties
      // call entirely.
      const watchNoOp = joinsIntoCurrentBody(f) && currentSolid() != null;
      const before = watchNoOp ? currentSolid()!.volume() : 0;
      lastCombineDegraded = false; // R8/K4: reset before this feature; set by combinePrimitive
      // R6: resolve any global-param expressions into concrete numeric params first.
      buildFeature(resolveFeatureExprs(f, doc.params ?? {}));
      const after = watchNoOp ? (currentSolid()?.volume() ?? 0) : 0;
      if (watchNoOp && Math.abs(after - before) <= before * 1e-9) {
        statuses.push({
          featureId: f.id,
          status: "warning",
          message:
            `feature '${f.id}' (${f.type}) joined the existing body but added no material — ` +
            `it lies entirely inside it, so nothing changed on screen. Set its op to "new" ` +
            `for a separate body, or move/resize it so it protrudes.`,
        });
      } else if (lastCombineDegraded) {
        // R8/K4: the kernel swallowed a UnifySameDomain failure and returned a
        // FRAGMENTED result — surface it instead of shipping the silent degrade.
        statuses.push({
          featureId: f.id,
          status: "warning",
          message:
            `feature '${f.id}' (${f.type}) built, but a boolean's UnifySameDomain step degraded ` +
            `and left a fragmented result — coplanar faces were not merged, so selecting one of ` +
            `them for a later fillet/shell/extrude-to-face may be unreliable.`,
        });
      } else {
        statuses.push({ featureId: f.id, status: "ok" });
      }
    } catch (err) {
      if (!isolate) throw err;
      // Isolating pass: record and skip. `solid` is untouched by a throw (every
      // kernel call frees its own temporaries in a finally and only `replace`
      // swaps the accumulator), so the previous body passes through.
      statuses.push({ featureId: f.id, status: "error", message: featureErrorMessage(f, err) });
    }
  }
  return { solid, statuses };

  /** Build one feature into the accumulator. Throws on any failure. */
  function buildFeature(f: EditorFeature): void {
    switch (f.type) {
      case "box": {
        // Box goes through the SAME op contract as every other primitive (§2.4):
        // join-by-default once a body exists, `cut`/`intersect` for the boolean
        // ops, `new` for a separate body. It previously called `replace()`
        // unconditionally, so a second box silently DESTROYED the first — §2.4's
        // defect, surviving in the one primitive the default document seeds.
        //
        // It also honours an origin (ox/oy/oz) like the round primitives do, so a
        // second box can actually be placed somewhere other than on top of the
        // first; `makeBoxAt` is the corner-placed constructor.
        const origin = primitivePlacement(f).origin ?? ([0, 0, 0] as Vec3);
        const box =
          origin[0] === 0 && origin[1] === 0 && origin[2] === 0
            ? makeBox(oc, num(f, "dx"), num(f, "dy"), num(f, "dz"))
            : makeBoxAt(oc, origin, num(f, "dx"), num(f, "dy"), num(f, "dz"));
        replace(combinePrimitive(oc, currentSolid(), box, f));
        break;
      }
      // Round primitives (§4.11). Box was the only primitive, which made the
      // sketcher a single point of failure for ALL round geometry.
      case "cylinder":
        replace(
          combinePrimitive(
            oc,
            currentSolid(),
            makeCylinder(oc, num(f, "radius"), num(f, "height"), primitivePlacement(f)),
            f,
          ),
        );
        break;
      case "sphere":
        replace(
          combinePrimitive(
            oc,
            currentSolid(),
            makeSphere(oc, num(f, "radius"), primitivePlacement(f)),
            f,
          ),
        );
        break;
      case "cone":
        replace(
          combinePrimitive(
            oc,
            currentSolid(),
            makeCone(
              oc,
              num(f, "radius1"),
              num(f, "radius2"),
              num(f, "height"),
              primitivePlacement(f),
            ),
            f,
          ),
        );
        break;
      case "torus":
        replace(
          combinePrimitive(
            oc,
            currentSolid(),
            makeTorus(oc, num(f, "majorRadius"), num(f, "minorRadius"), primitivePlacement(f)),
            f,
          ),
        );
        break;
      case "sketch": {
        let prof = f.data?.["profile"] as Profile | undefined;
        // Back-compat: documents saved before the typed-profile change (D2)
        // carry only `data.model` (+ a legacy `data.points`). Re-derive the
        // profile from the persisted constraint model so old projects still load.
        if (!isProfile(prof)) {
          const model = f.data?.["model"] as SketchModel | undefined;
          prof = model ? (extractProfile(model) ?? undefined) : undefined;
        }
        if (!isProfile(prof)) {
          throw new Error(
            `feature '${f.id}' (sketch): no buildable profile (closed loop or circle)`,
          );
        }
        const planeSpec = f.data?.["plane"] as SketchPlaneSpec | undefined;
        let sketchPlane: DatumPlane;
        if (isFaceSketchPlane(planeSpec)) {
          // On-face plane: resolve the face on the current solid and frame it
          // (parametric — re-derived each rebuild as the face moves).
          if (!solid)
            throw new Error(`feature '${f.id}' (sketch): an on-face plane needs an upstream body`);
          const face = resolveFaceRef(oc, solid, planeSpec.face);
          if (!face)
            throw new Error(`feature '${f.id}' (sketch): the on-face plane's face was not found`);
          try {
            sketchPlane = offsetPlane(faceDatumPlane(oc, face), planeSpec.offset);
          } finally {
            face.delete();
          }
        } else {
          sketchPlane = resolveSketchPlane(planeSpec);
        }
        const entry: ActiveSketch = {
          profile: prof,
          plane: sketchPlane,
          onFace: isFaceSketchPlane(planeSpec),
          ...(isFaceSketchPlane(planeSpec) && planeSpec.offset === 0
            ? { support: planeSpec.face }
            : {}),
        };
        sketches.set(f.id, entry);
        lastSketch = entry;
        break;
      }
      case "extrude": {
        const activeSketch = sketchForFeature(
          f,
          sketches,
          lastSketch,
          allFeatureIds,
          sketchFeatureIds,
        );
        if (!activeSketch)
          throw new Error(`feature '${f.id}' (extrude): no sketch profile upstream`);
        const sk = profileSketch(activeSketch.profile, activeSketch.plane);
        // Direction override: a baked vector, or re-resolved from a picked edge.
        let direction: Vec3 | undefined;
        const dirVec = f.data?.["direction"];
        if (Array.isArray(dirVec) && dirVec.length === 3) {
          direction = [Number(dirVec[0]), Number(dirVec[1]), Number(dirVec[2])];
        } else if (f.data?.["directionEdge"]) {
          if (!solid)
            throw new Error(`feature '${f.id}' (extrude): no body for the direction edge`);
          const d = resolveEdgeDirection(oc, solid, f.data["directionEdge"] as EdgeRef);
          if (!d) throw new Error(`feature '${f.id}' (extrude): direction edge unresolved`);
          direction = d;
        }
        // Extrude up to a picked face (joined to the body it terminates on), or a
        // blind / two-sided pad as a new body (FR-29).
        const toFace = f.data?.["toFace"] as FaceRef | undefined;
        const height = opt(f, "height", NaN);
        const back = opt(f, "back", 0);
        const draftAngle = opt(f, "draftAngle", 0);
        const hasHoles = activeSketch.profile.kind === "loop" && activeSketch.profile.holes?.length;
        const localOp = (f.data?.["op"] ?? "join") as string;
        const canUseNative =
          solid != null &&
          activeSketch.support != null &&
          back === 0 &&
          !hasHoles &&
          (localOp === "join" || localOp === "cut");
        if (draftAngle !== 0 && !canUseNative) {
          throw new Error(
            `feature '${f.id}' (extrude): draftAngle requires a zero-offset sketch on a model face, ` +
              `a join/cut operation, no back extrusion, and no profile holes`,
          );
        }
        if (canUseNative) {
          const base = solid!;
          replace(
            finishHistoryResult(
              oc,
              doc,
              f.id,
              base,
              nativePrism(oc, base, sk, {
                support: activeSketch.support!,
                ...(toFace ? { until: toFace } : { length: height }),
                ...(draftAngle !== 0 ? { draftAngle } : {}),
                op: localOp === "cut" ? "cut" : "join",
                ...(direction ? { direction } : {}),
              }),
            ),
          );
          break;
        }
        if (toFace) {
          const base = solid;
          if (!base) throw new Error(`feature '${f.id}' (extrude to face): no upstream body`);
          const pad = extrudeToFace(oc, sk, base, toFace, direction ? { direction } : {});
          try {
            const r = union(oc, base, pad);
            if (!r.ok) throw new Error(`feature '${f.id}' (extrude to face): ${r.error}`);
            releaseBooleanHistory(r);
            replace(r.solid);
          } finally {
            pad.delete();
          }
        } else {
          // Join-by-default when a body already exists (C1 / Grok): a second pad
          // adds material instead of destroying the prior solid. Explicit
          // data.op === "new" keeps replace (historical single-body / "new body").
          // data.op === "join" always joins when a solid is present.
          const height = num(f, "height");
          let pad = extrude(oc, sk, height, { back, direction });
          pad = cutProfileHoles(
            oc,
            pad,
            activeSketch.profile,
            activeSketch.plane,
            height,
            { back, direction },
            f.id,
          );
          // R9/P3: honour data.op FULLY — "cut"→subtract, "intersect"→intersect,
          // "new"→separate body, else join — instead of silently joining every
          // non-"new" op (which turned a legacy/AI `op:"cut"` extrude into a
          // silent pad). combinePrimitive owns the op contract and frees the tool.
          replace(combinePrimitive(oc, solid, pad, f));
        }
        break;
      }
      case "rib": {
        const activeSketch = sketchForFeature(
          f,
          sketches,
          lastSketch,
          allFeatureIds,
          sketchFeatureIds,
        );
        if (!activeSketch) throw new Error(`feature '${f.id}' (rib): no sketch profile upstream`);
        const directionData = f.data?.["direction"];
        const direction: Vec3 | undefined =
          Array.isArray(directionData) && directionData.length === 3
            ? [Number(directionData[0]), Number(directionData[1]), Number(directionData[2])]
            : undefined;
        const form = linearForm(
          oc,
          profileSketch(activeSketch.profile, activeSketch.plane),
          num(f, "length"),
          direction,
        );
        replace(combinePrimitive(oc, solid, form, f));
        break;
      }
      case "revolve": {
        const activeSketch = sketchForFeature(
          f,
          sketches,
          lastSketch,
          allFeatureIds,
          sketchFeatureIds,
        );
        if (!activeSketch)
          throw new Error(`feature '${f.id}' (revolve): no sketch profile upstream`);
        // Revolve the active profile about an axis through (ox,oy,oz) along
        // (ax,ay,az) by `angle` radians (FR-29). Defaults: world Y through origin.
        // data.axisEdge (C2): re-resolve axis origin+direction from a picked edge.
        const angle = num(f, "angle");
        let origin: Vec3 = [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)];
        let axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 1), opt(f, "az", 0)];
        const axisEdge = f.data?.["axisEdge"] as EdgeRef | undefined;
        if (axisEdge) {
          if (!solid) throw new Error(`feature '${f.id}' (revolve): no body for the axis edge`);
          try {
            const ea = resolveEdgeAxis(oc, solid, axisEdge);
            origin = [ea.origin[0], ea.origin[1], ea.origin[2]];
            axis = [ea.direction[0], ea.direction[1], ea.direction[2]];
          } catch {
            throw new Error(`feature '${f.id}' (revolve): axis edge unresolved`);
          }
        }
        let body = revolve(
          oc,
          profileSketch(activeSketch.profile, activeSketch.plane),
          origin,
          axis,
          angle,
        );
        // C9 / §2.7: profile.holes → revolve each hole (circle OR inner loop) and
        // subtract (ring solid of revolution).
        const prof = activeSketch.profile;
        if (prof.kind === "loop" && prof.holes?.length) {
          for (const h of prof.holes) {
            const holeSk =
              h.kind === "circle"
                ? Sketch.circle(activeSketch.plane, h.center[0], h.center[1], h.radius)
                : profileSketch(
                    { kind: "loop", start: h.start, segments: h.segments },
                    activeSketch.plane,
                  );
            const tool = revolve(oc, holeSk, origin, axis, angle);
            try {
              const r = subtract(oc, body, tool);
              body.delete();
              if (!r.ok) throw new Error(`feature '${f.id}' (revolve hole): ${r.error}`);
              releaseBooleanHistory(r);
              body = r.solid;
            } finally {
              tool.delete();
            }
          }
        }
        // R9/P3: full op contract (cut/intersect/new/join) via combinePrimitive,
        // instead of silently joining every non-"new" op.
        replace(combinePrimitive(oc, solid, body, f));
        break;
      }
      case "loft": {
        // Loft through ≥2 section profiles (FR-32). Each section is either on an
        // offset of its own plane (G6: `plane` / legacy `z` on world-XY) so
        // non-XY / non-parallel stacks are expressible.
        const sections = f.data?.["sections"] as
          | { profile: Profile; z?: number; plane?: SketchPlaneSpec }[]
          | undefined;
        if (!Array.isArray(sections) || sections.length < 2) {
          throw new Error(`feature '${f.id}' (loft): needs ≥2 section profiles`);
        }
        const sketches = sections.map((s, i) => {
          let plane: DatumPlane;
          if (s.plane && isFaceSketchPlane(s.plane)) {
            if (!solid)
              throw new Error(
                `feature '${f.id}' (loft): section ${i} on-face plane needs an upstream body`,
              );
            const face = resolveFaceRef(oc, solid, s.plane.face);
            if (!face)
              throw new Error(
                `feature '${f.id}' (loft): section ${i} on-face plane's face was not found`,
              );
            try {
              plane = offsetPlane(faceDatumPlane(oc, face), s.plane.offset);
            } finally {
              face.delete();
            }
          } else if (s.plane) {
            plane = resolveSketchPlane(s.plane);
          } else {
            // Legacy: z offset on world-XY (back-compat with existing documents).
            plane = offsetPlane(planeXY(), typeof s.z === "number" ? s.z : 0);
          }
          return profileSketch(s.profile, plane);
        });
        {
          // Join-by-default when a body exists (C4 / Grok): same op contract as extrude.
          const body = loft(oc, sketches, { ruled: Boolean(f.data?.["ruled"]) });
          // R9/P3: full op contract (cut/intersect/new/join) via combinePrimitive.
          replace(combinePrimitive(oc, solid, body, f));
        }
        break;
      }
      case "sweep": {
        // Sweep a profile along a polyline / mixed line+arc path (FR-32 / G4), a
        // helical spine (data.helix → helix() + sweepAlongWire, §13.2), or edges
        // picked on the model (pathEdges). The profile plane is taken from
        // data.plane (explicit), else the active sketch's plane, else world-XY —
        // so a non-XY profile is not forced onto XY (G3).
        const prof = f.data?.["profile"] as Profile | undefined;
        const path = f.data?.["path"] as SpinePath | undefined;
        // Helical spine (§13.2): not a SpinePath kind — kernel helix() builds the
        // wire; rebuild hands it to sweepAlongWire (which consumes ownership).
        const helixSpec = parseHelixSpec(f.data?.["helix"], f.id);
        // A spine picked on the model (FR-32): persistent EdgeRefs re-resolved
        // against the current body each rebuild, so the swept pipe FOLLOWS its
        // edges when an upstream parameter moves them. Precedence: pathEdges >
        // helix > path.
        const pathEdges = f.data?.["pathEdges"] as EdgeRef[] | undefined;
        if (!isProfile(prof)) throw new Error(`feature '${f.id}' (sweep): no profile`);
        if (!path && !helixSpec && !(pathEdges && pathEdges.length > 0)) {
          throw new Error(`feature '${f.id}' (sweep): no path`);
        }
        const planeSpec = f.data?.["plane"] as SketchPlaneSpec | undefined;
        let sweepPlane: DatumPlane;
        if (isFaceSketchPlane(planeSpec)) {
          if (!solid)
            throw new Error(`feature '${f.id}' (sweep): an on-face plane needs an upstream body`);
          const face = resolveFaceRef(oc, solid, planeSpec.face);
          if (!face)
            throw new Error(`feature '${f.id}' (sweep): the on-face plane's face was not found`);
          try {
            sweepPlane = offsetPlane(faceDatumPlane(oc, face), planeSpec.offset);
          } finally {
            face.delete();
          }
        } else if (planeSpec) {
          sweepPlane = resolveSketchPlane(planeSpec);
        } else {
          const bound = sketchForFeature(f, sketches, lastSketch, allFeatureIds, sketchFeatureIds);
          sweepPlane = bound?.plane ?? planeXY();
        }
        const modeRaw = f.data?.["mode"];
        const transitionRaw = f.data?.["transition"];
        // "fixed" was removed as a lie (T17/C8) — map legacy docs to correctedFrenet.
        const modeNorm = modeRaw === "fixed" ? "correctedFrenet" : modeRaw;
        const sweepOpts: SweepOptions | undefined =
          modeNorm === "frenet" ||
          modeNorm === "correctedFrenet" ||
          transitionRaw === "right" ||
          transitionRaw === "round" ||
          transitionRaw === "transformed"
            ? {
                ...(modeNorm === "frenet" || modeNorm === "correctedFrenet"
                  ? { mode: modeNorm as SweepOptions["mode"] }
                  : {}),
                ...(transitionRaw === "right" ||
                transitionRaw === "round" ||
                transitionRaw === "transformed"
                  ? { transition: transitionRaw as SweepOptions["transition"] }
                  : {}),
              }
            : undefined;
        {
          // Join-by-default when a body exists (C4 / Grok): same op contract as extrude.
          const sk = profileSketch(prof, sweepPlane);
          const body = pathEdges?.length
            ? sweepAlongPickedEdges(oc, currentSolid(), sk, pathEdges, f.id, sweepOpts)
            : helixSpec
              ? // helix() returns a ready wire; sweepAlongWire takes ownership.
                sweepAlongWire(oc, sk, helix(oc, helixSpec), sweepOpts)
              : sweep(oc, sk, path!, sweepOpts);
          // R9/P3: full op contract (cut/intersect/new/join) via combinePrimitive.
          replace(combinePrimitive(oc, solid, body, f));
        }
        break;
      }
      case "cut": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (cut): no solid to cut into`);
        const activeSketch = sketchForFeature(
          f,
          sketches,
          lastSketch,
          allFeatureIds,
          sketchFeatureIds,
        );
        if (!activeSketch) throw new Error(`feature '${f.id}' (cut): no sketch profile upstream`);
        // Subtract the active profile, extruded `depth` (optionally two-sided via
        // `back`, optionally along a baked/edge direction — parity with extrude, G5),
        // from the current solid (a pocket/through-cut; FR-29).
        let direction: Vec3 | undefined;
        const dirVec = f.data?.["direction"];
        if (Array.isArray(dirVec) && dirVec.length === 3) {
          direction = [Number(dirVec[0]), Number(dirVec[1]), Number(dirVec[2])];
        } else if (f.data?.["directionEdge"]) {
          const d = resolveEdgeDirection(oc, base, f.data["directionEdge"] as EdgeRef);
          if (!d) throw new Error(`feature '${f.id}' (cut): direction edge unresolved`);
          direction = d;
        }
        const depth = num(f, "depth");
        const back = opt(f, "back", 0);
        const draftAngle = opt(f, "draftAngle", 0);
        // A cut sketched ON a model face must go INTO the body (§13.8 P0). A face
        // plane's normal points OUTWARD, so extruding the tool along it would
        // sweep through empty space and remove exactly nothing — the same
        // "operation did nothing" defect this pass exists to kill, mirrored. A
        // DATUM-plane cut keeps sweeping +normal (a sketch under the body cuts
        // upward into it), and an explicit direction always wins.
        if (!direction && activeSketch.onFace) {
          const n = activeSketch.plane.normal;
          direction = [-n[0], -n[1], -n[2]];
        }
        const hasHoles = activeSketch.profile.kind === "loop" && activeSketch.profile.holes?.length;
        const canUseNative = activeSketch.support != null && back === 0 && !hasHoles;
        if (draftAngle !== 0 && !canUseNative) {
          throw new Error(
            `feature '${f.id}' (cut): draftAngle requires a zero-offset sketch on a model face, ` +
              `no back extrusion, and no profile holes`,
          );
        }
        if (canUseNative) {
          replace(
            finishHistoryResult(
              oc,
              doc,
              f.id,
              base,
              nativePrism(oc, base, profileSketch(activeSketch.profile, activeSketch.plane), {
                support: activeSketch.support!,
                length: depth,
                ...(draftAngle !== 0 ? { draftAngle } : {}),
                op: "cut",
                ...(direction ? { direction } : {}),
              }),
            ),
          );
          break;
        }
        // Outer cut tool; profile.holes on cut leave islands via cutProfileHoles on the tool
        // so the tool is a ring (outer minus holes) before subtracting from the body.
        let tool = extrude(oc, profileSketch(activeSketch.profile, activeSketch.plane), depth, {
          back,
          direction,
        });
        tool = cutProfileHoles(
          oc,
          tool,
          activeSketch.profile,
          activeSketch.plane,
          depth,
          { back, direction },
          f.id,
        );
        try {
          replace(cut(oc, base, tool));
        } finally {
          tool.delete();
        }
        break;
      }
      case "fillet": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (fillet): no solid to fillet`);
        // Explicit EdgeRefs (re-resolved each rebuild, FR-16/R2) or a selector predicate (R3.2).
        const edges = dressEdges(oc, base, f);
        if (edges.length === 0) throw new Error(`feature '${f.id}' (fillet): no edges selected`);
        // Optional radius2 → variable-radius fillet along each edge (T20).
        const endR = opt(f, "radius2", NaN);
        replace(
          finishHistoryResult(
            oc,
            doc,
            f.id,
            base,
            filletWithHistory(
              oc,
              base,
              edges,
              num(f, "radius"),
              Number.isFinite(endR) ? { endRadius: endR } : undefined,
            ),
          ),
        );
        break;
      }
      case "chamfer": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (chamfer): no solid to chamfer`);
        const edges = dressEdges(oc, base, f);
        if (edges.length === 0) throw new Error(`feature '${f.id}' (chamfer): no edges selected`);
        // Optional distance2 + data.face → two-distance chamfer (T20).
        const d2 = opt(f, "distance2", NaN);
        const chFace = f.data?.["face"] as FaceRef | undefined;
        replace(
          finishHistoryResult(
            oc,
            doc,
            f.id,
            base,
            chamferWithHistory(
              oc,
              base,
              edges,
              num(f, "distance"),
              Number.isFinite(d2) && chFace ? { distance2: d2, face: chFace } : undefined,
            ),
          ),
        );
        break;
      }
      case "shell": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (shell): no solid to shell`);
        const faces = dressFaces(oc, base, f);
        if (faces.length === 0) throw new Error(`feature '${f.id}' (shell): no faces selected`);
        const shellOpts: ShellOptions | undefined =
          f.data?.["direction"] === "outward" ? { direction: "outward" } : undefined;
        replace(
          finishHistoryResult(
            oc,
            doc,
            f.id,
            base,
            shellWithHistory(oc, base, faces, num(f, "thickness"), shellOpts),
          ),
        );
        break;
      }
      case "draft": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (draft): no solid to draft`);
        // Prefer multi-face selection (G9); fall back to single `data.face` or first dress face.
        const facesFromData = f.data?.["faces"] as FaceRef[] | undefined;
        const faces: FaceRef[] =
          Array.isArray(facesFromData) && facesFromData.length > 0
            ? facesFromData
            : f.data?.["face"]
              ? [f.data["face"] as FaceRef]
              : dressFaces(oc, base, f);
        if (faces.length === 0) throw new Error(`feature '${f.id}' (draft): no face selected`);
        const vec = (key: string, d: Vec3): Vec3 => {
          const v = f.data?.[key];
          return Array.isArray(v) && v.length === 3
            ? [Number(v[0]), Number(v[1]), Number(v[2])]
            : d;
        };
        const pull = vec("pull", [0, 0, 1]);
        const neutralOrigin = vec("neutralOrigin", [0, 0, 0]);
        const neutralNormal = vec("neutralNormal", [0, 0, 1]);
        const angle = num(f, "angle");
        // §13.2 draftMulti: all faces drafted in ONE BRepOffsetAPI_DraftAngle build
        // (was a per-face sequential loop, which re-based on each prior solid and
        // could compound tolerance across faces). The kernel op now takes faces[].
        replace(
          finishHistoryResult(
            oc,
            doc,
            f.id,
            base,
            draftWithHistory(oc, base, {
              faces,
              pullDirection: pull,
              neutralOrigin,
              neutralNormal,
              angle,
            }),
          ),
        );
        break;
      }
      case "hole": {
        // §13.2 real hole feature — simple / counterbore / countersink / spotface,
        // blind or through-all, optional drill tip. Composed in the kernel from
        // primitives + subtract; every dimension is an editable param.
        // R12: when authored from a vertex pick, data.originVertex carries the
        // VertexRef signature; re-resolve it so the drill point follows the
        // corner across an upstream resize (origin vector is the fallback).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (hole): no solid`);
        const v3 = (key: string): Vec3 => {
          const v = f.data?.[key];
          if (!Array.isArray(v) || v.length !== 3) {
            throw new Error(`feature '${f.id}' (hole): data.${key} must be a 3-vector`);
          }
          return [Number(v[0]), Number(v[1]), Number(v[2])];
        };
        let origin = v3("origin");
        const originVertex = f.data?.["originVertex"] as VertexRef | undefined;
        if (
          originVertex &&
          typeof originVertex === "object" &&
          Array.isArray(originVertex.position)
        ) {
          const vtx = resolveVertexRef(oc, base, originVertex);
          if (vtx) {
            try {
              const p = oc.BRep_Tool.Pnt(vtx);
              origin = [p.X(), p.Y(), p.Z()];
              p.delete();
            } finally {
              vtx.delete();
            }
          }
          // Unresolved VertexRef keeps the baked origin vector (fail soft — the
          // hole still builds; the corner may have been filleted away).
        }
        const kind = (f.data?.["kind"] as HoleKind | undefined) ?? "simple";
        const throughAll = f.data?.["throughAll"] === true;
        const spec: HoleSpec = {
          origin,
          axis: v3("axis"),
          diameter: num(f, "diameter"),
          kind,
          ...(throughAll ? { throughAll: true } : { depth: num(f, "depth") }),
          ...(kind === "counterbore" || kind === "spotface"
            ? {
                counterboreDiameter: num(f, "counterboreDiameter"),
                counterboreDepth: num(f, "counterboreDepth"),
              }
            : {}),
          ...(kind === "countersink"
            ? {
                countersinkDiameter: num(f, "countersinkDiameter"),
                countersinkAngle: num(f, "countersinkAngle"),
              }
            : {}),
          ...(typeof f.params?.["tipAngle"] === "number" ? { tipAngle: f.params["tipAngle"] } : {}),
        };
        replace(hole(oc, base, spec));
        break;
      }
      case "thicken": {
        // §13.2/§14 surface→solid solidifier. The current solid must be an open
        // face/shell (or a thin body MakeThickSolidBySimple accepts); thickness
        // is the wall; data.bothSides centres the wall on the surface mid-plane.
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (thicken): no solid`);
        const thickness = num(f, "thickness");
        const bothSides = f.data?.["bothSides"] === true;
        replace(thicken(oc, base, thickness, bothSides ? { bothSides: true } : undefined));
        break;
      }
      case "surfaceLoft": {
        // §14 open-shell loft (ThruSections isSolid=false). Same section authoring
        // as solid loft; result is a zero-volume sheet (thicken to plate).
        const sections = f.data?.["sections"] as
          | { profile: Profile; z?: number; plane?: SketchPlaneSpec }[]
          | undefined;
        if (!Array.isArray(sections) || sections.length < 2) {
          throw new Error(`feature '${f.id}' (surfaceLoft): needs ≥2 section profiles`);
        }
        const sketches = sections.map((s, i) => {
          let plane: DatumPlane;
          if (s.plane && isFaceSketchPlane(s.plane)) {
            if (!solid)
              throw new Error(
                `feature '${f.id}' (surfaceLoft): section ${i} on-face plane needs an upstream body`,
              );
            const face = resolveFaceRef(oc, solid, s.plane.face);
            if (!face)
              throw new Error(
                `feature '${f.id}' (surfaceLoft): section ${i} on-face plane's face was not found`,
              );
            try {
              plane = offsetPlane(faceDatumPlane(oc, face), s.plane.offset);
            } finally {
              face.delete();
            }
          } else if (s.plane) {
            plane = resolveSketchPlane(s.plane);
          } else {
            plane = offsetPlane(planeXY(), typeof s.z === "number" ? s.z : 0);
          }
          return profileSketch(s.profile, plane);
        });
        // Sheet bodies REPLACE the accumulator (not boolean-joined). op:"new"
        // keeps the prior body alongside the shell via a compound.
        {
          const body = surfaceLoft(oc, sketches, { ruled: Boolean(f.data?.["ruled"]) });
          if (solid && f.data?.["op"] === "new") replace(newBody(oc, solid, body));
          else replace(body);
        }
        break;
      }
      case "surfaceSweep": {
        // §14 open pipe shell — MakePipeShell without MakeSolid. Authoring mirrors
        // solid sweep (profile + path / pathEdges + optional plane/mode/transition).
        const prof = f.data?.["profile"] as Profile | undefined;
        const path = f.data?.["path"] as SpinePath | undefined;
        const pathEdges = f.data?.["pathEdges"] as EdgeRef[] | undefined;
        if (!isProfile(prof)) throw new Error(`feature '${f.id}' (surfaceSweep): no profile`);
        if (!path && !(pathEdges && pathEdges.length > 0)) {
          throw new Error(`feature '${f.id}' (surfaceSweep): no path`);
        }
        const planeSpec = f.data?.["plane"] as SketchPlaneSpec | undefined;
        let sweepPlane: DatumPlane;
        if (isFaceSketchPlane(planeSpec)) {
          if (!solid)
            throw new Error(
              `feature '${f.id}' (surfaceSweep): an on-face plane needs an upstream body`,
            );
          const face = resolveFaceRef(oc, solid, planeSpec.face);
          if (!face)
            throw new Error(
              `feature '${f.id}' (surfaceSweep): the on-face plane's face was not found`,
            );
          try {
            sweepPlane = offsetPlane(faceDatumPlane(oc, face), planeSpec.offset);
          } finally {
            face.delete();
          }
        } else if (planeSpec) {
          sweepPlane = resolveSketchPlane(planeSpec);
        } else {
          const bound = sketchForFeature(f, sketches, lastSketch, allFeatureIds, sketchFeatureIds);
          sweepPlane = bound?.plane ?? planeXY();
        }
        const modeRaw = f.data?.["mode"];
        const transitionRaw = f.data?.["transition"];
        const modeNorm = modeRaw === "fixed" ? "correctedFrenet" : modeRaw;
        const sweepOpts: SweepOptions | undefined =
          modeNorm === "frenet" ||
          modeNorm === "correctedFrenet" ||
          transitionRaw === "right" ||
          transitionRaw === "round" ||
          transitionRaw === "transformed"
            ? {
                ...(modeNorm === "frenet" || modeNorm === "correctedFrenet"
                  ? { mode: modeNorm as SweepOptions["mode"] }
                  : {}),
                ...(transitionRaw === "right" ||
                transitionRaw === "round" ||
                transitionRaw === "transformed"
                  ? { transition: transitionRaw as SweepOptions["transition"] }
                  : {}),
              }
            : undefined;
        {
          const body = pathEdges?.length
            ? surfaceSweepAlongPickedEdges(
                oc,
                currentSolid(),
                profileSketch(prof, sweepPlane),
                pathEdges,
                f.id,
                sweepOpts,
              )
            : surfaceSweep(oc, profileSketch(prof, sweepPlane), path!, sweepOpts);
          if (solid && f.data?.["op"] === "new") replace(newBody(oc, solid, body));
          else replace(body);
        }
        break;
      }
      case "surfaceRevolve": {
        // §14 surface of revolution from a profile wire (MakeRevol on wire, not face).
        // Profile from data.profile+plane, else the active sketch (same as revolve).
        const dataProf = f.data?.["profile"] as Profile | undefined;
        let revProfile: Profile;
        let revPlane: DatumPlane;
        if (isProfile(dataProf)) {
          revProfile = dataProf;
          const planeSpec = f.data?.["plane"] as SketchPlaneSpec | undefined;
          if (isFaceSketchPlane(planeSpec)) {
            if (!solid)
              throw new Error(
                `feature '${f.id}' (surfaceRevolve): an on-face plane needs an upstream body`,
              );
            const face = resolveFaceRef(oc, solid, planeSpec.face);
            if (!face)
              throw new Error(
                `feature '${f.id}' (surfaceRevolve): the on-face plane's face was not found`,
              );
            try {
              revPlane = offsetPlane(faceDatumPlane(oc, face), planeSpec.offset);
            } finally {
              face.delete();
            }
          } else if (planeSpec) {
            revPlane = resolveSketchPlane(planeSpec);
          } else {
            revPlane = planeXY();
          }
        } else {
          const activeSketch = sketchForFeature(
            f,
            sketches,
            lastSketch,
            allFeatureIds,
            sketchFeatureIds,
          );
          if (!activeSketch)
            throw new Error(`feature '${f.id}' (surfaceRevolve): no sketch profile upstream`);
          revProfile = activeSketch.profile;
          revPlane = activeSketch.plane;
        }
        const angle = num(f, "angle");
        let origin: Vec3 = [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)];
        let axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 1), opt(f, "az", 0)];
        const axisEdge = f.data?.["axisEdge"] as EdgeRef | undefined;
        if (axisEdge) {
          if (!solid)
            throw new Error(`feature '${f.id}' (surfaceRevolve): no body for the axis edge`);
          try {
            const ea = resolveEdgeAxis(oc, solid, axisEdge);
            origin = [ea.origin[0], ea.origin[1], ea.origin[2]];
            axis = [ea.direction[0], ea.direction[1], ea.direction[2]];
          } catch {
            throw new Error(`feature '${f.id}' (surfaceRevolve): axis edge unresolved`);
          }
        }
        {
          const body = surfaceRevolve(oc, profileSketch(revProfile, revPlane), origin, axis, angle);
          if (solid && f.data?.["op"] === "new") replace(newBody(oc, solid, body));
          else replace(body);
        }
        break;
      }
      case "surfaceFromPoints": {
        // §14 B-spline face through a rectangular point grid (SI metres in data).
        const grid = f.data?.["grid"] as [number, number, number][][] | undefined;
        if (!Array.isArray(grid) || grid.length < 2) {
          throw new Error(`feature '${f.id}' (surfaceFromPoints): needs a ≥2×2 point grid`);
        }
        const degU =
          typeof f.params?.["degU"] === "number" ? (f.params["degU"] as number) : undefined;
        const degV =
          typeof f.params?.["degV"] === "number" ? (f.params["degV"] as number) : undefined;
        const tolerance =
          typeof f.params?.["tolerance"] === "number"
            ? (f.params["tolerance"] as number)
            : undefined;
        const body = surfaceFromPoints(oc, grid, {
          ...(degU !== undefined ? { degU } : {}),
          ...(degV !== undefined ? { degV } : {}),
          ...(tolerance !== undefined ? { tolerance } : {}),
        });
        if (solid && f.data?.["op"] === "new") replace(newBody(oc, solid, body));
        else replace(body);
        break;
      }
      case "offsetSurface": {
        // §14 offset skin of the current face/shell (not a solid plate — use thicken).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (offsetSurface): no solid`);
        replace(offsetSurface(oc, base, num(f, "distance")));
        break;
      }
      case "sew": {
        // §14 sew the current body's faces into a shell (heal free edges within tolerance).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (sew): no solid`);
        const tolerance = opt(f, "tolerance", 1e-6);
        // Sewing accepts the whole shape; OCCT explores faces internally.
        const { shell } = sew(oc, [base], tolerance);
        replace(shell);
        break;
      }
      case "solidify": {
        // §14 promote a closed shell to a solid. Free edges must be zero (sew first).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (solidify): no solid`);
        replace(solidify(oc, base));
        break;
      }
      case "patch": {
        // §14 free-edge fill: MakeFilling over a closed boundary of free edges.
        // data.edges carries EdgeRefs (prefer free edges from the open shell).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (patch): no solid`);
        const edgeRefs = f.data?.["edges"] as EdgeRef[] | undefined;
        if (!Array.isArray(edgeRefs) || edgeRefs.length < 3) {
          throw new Error(`feature '${f.id}' (patch): needs data.edges with ≥3 free edges`);
        }
        const edges = [];
        for (const ref of edgeRefs) {
          const e = resolveEdgeRef(oc, base, ref);
          if (!e) throw new Error(`feature '${f.id}' (patch): edge did not resolve`);
          edges.push(e);
        }
        try {
          const continuity =
            (f.data?.["continuity"] as "c0" | "c1" | "g1" | "c2" | "g2" | undefined) ?? "c0";
          replace(patch(oc, edges, { continuity }));
        } finally {
          for (const e of edges) e.delete();
        }
        break;
      }
      case "trim": {
        // §14 keep-one-side plane trim — data.plane {origin, normal, xAxis?} + keep.
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (trim): no solid`);
        const pl = f.data?.["plane"] as
          | { origin?: unknown; normal?: unknown; xAxis?: unknown }
          | undefined;
        if (!pl || !Array.isArray(pl.origin) || !Array.isArray(pl.normal)) {
          throw new Error(`feature '${f.id}' (trim): data.plane.origin/normal required`);
        }
        const origin: Vec3 = [Number(pl.origin[0]), Number(pl.origin[1]), Number(pl.origin[2])];
        const normal: Vec3 = [Number(pl.normal[0]), Number(pl.normal[1]), Number(pl.normal[2])];
        const xAxis: Vec3 = Array.isArray(pl.xAxis)
          ? [Number(pl.xAxis[0]), Number(pl.xAxis[1]), Number(pl.xAxis[2])]
          : ([0, 1, 0] as Vec3);
        const keep = f.data?.["keep"] === "negative" ? "negative" : "positive";
        replace(trimSurface(oc, base, { origin, normal, xAxis }, { keep }));
        break;
      }
      case "transform": {
        // Baked rigid move of the current solid (FR-31; distinct from placement gizmo).
        // Order: rotate about pivot (COM by default, or explicit px/py/pz), then translate (C7).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (transform): no solid`);
        const angle = opt(f, "angle", 0);
        const tx = opt(f, "tx", 0);
        const ty = opt(f, "ty", 0);
        const tz = opt(f, "tz", 0);
        let current = base;
        let owned: Solid | null = null;
        if (angle !== 0) {
          const axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 0), opt(f, "az", 1)];
          // Explicit pivot params override COM (optional px/py/pz); default = body centre of mass.
          const com = base.centreOfMass();
          const pivot: Vec3 = [
            typeof f.params?.["px"] === "number" ? (f.params["px"] as number) : com[0],
            typeof f.params?.["py"] === "number" ? (f.params["py"] as number) : com[1],
            typeof f.params?.["pz"] === "number" ? (f.params["pz"] as number) : com[2],
          ];
          owned = rotate(oc, current, pivot, axis, angle);
          current = owned;
        }
        if (tx !== 0 || ty !== 0 || tz !== 0) {
          const moved = translate(oc, current, [tx, ty, tz]);
          if (owned) owned.delete();
          // `owned` (not `current`) carries the result to replace() below — this
          // is the last read of `current`.
          owned = moved;
        }
        if (owned) replace(owned);
        // No-op transform (all zeros): leave solid unchanged.
        break;
      }
      case "scale": {
        // Uniform resize of the current solid about a pivot (§2.5). The kernel op
        // existed but was reachable from nowhere — a user could not resize a body.
        // Uniform-only by design (a non-uniform scale is not a similarity transform
        // and would degrade every analytic FaceRef surface to a B-spline).
        const base = currentSolid();
        if (!base) throw new Error(`feature '${f.id}' (scale): no solid`);
        const factor = opt(f, "factor", 1);
        const centre: Vec3 = [opt(f, "px", 0), opt(f, "py", 0), opt(f, "pz", 0)];
        // factor === 1 is a no-op; scale() itself rejects factor <= 0 loudly.
        if (factor !== 1) replace(scale(oc, base, factor, centre));
        break;
      }
      case "mirror": {
        // Mirror the current solid across a plane; union with the original by
        // default to make a symmetric body (FR-31).
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (mirror): no solid`);
        const origin: Vec3 = [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)];
        const normal: Vec3 = [opt(f, "nx", 1), opt(f, "ny", 0), opt(f, "nz", 0)];
        const mir = mirror(oc, base, origin, normal);
        if (opt(f, "merge", 1) !== 0) {
          const r = union(oc, base, mir);
          mir.delete();
          if (!r.ok) throw new Error(`feature '${f.id}' (mirror union): ${r.error}`);
          releaseBooleanHistory(r);
          replace(r.solid);
        } else {
          replace(mir);
        }
        break;
      }
      case "linearPattern": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (linearPattern): no solid`);
        const dir: Vec3 = [opt(f, "dx", 1), opt(f, "dy", 0), opt(f, "dz", 0)];
        const count = Math.round(num(f, "count"));
        const spacing = num(f, "spacing");
        // T21: optional toolFeatures subtree = pattern that body and union onto base
        // (feature-scope pattern), not the whole current solid.
        const tools = f.data?.["toolFeatures"] as EditorFeature[] | undefined;
        if (Array.isArray(tools) && tools.length > 0) {
          const seed = rebuildDocument(oc, { features: tools, params: doc.params ?? {} });
          if (!seed) throw new Error(`feature '${f.id}' (linearPattern): tool body is empty`);
          const copies = linearPattern(oc, seed, dir, spacing, count);
          seed.delete();
          try {
            let acc: Solid = base;
            let owned: Solid | null = null;
            for (const c of copies) {
              const r = union(oc, acc, c);
              if (owned) owned.delete();
              if (!r.ok)
                throw new Error(`feature '${f.id}' (linearPattern tool union): ${r.error}`);
              releaseBooleanHistory(r);
              owned = r.solid;
              acc = r.solid;
            }
            replace(acc);
            owned = null;
          } finally {
            for (const c of copies) c.delete();
          }
        } else {
          const copies = linearPattern(oc, base, dir, spacing, count);
          try {
            replace(fusePatternCopies(oc, copies, f.id));
          } finally {
            for (const c of copies) c.delete();
          }
        }
        break;
      }
      case "circularPattern": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (circularPattern): no solid`);
        const origin: Vec3 = [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)];
        const axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 0), opt(f, "az", 1)];
        const count = Math.round(num(f, "count"));
        const angle = opt(f, "angle", Math.PI * 2);
        // C6: feature-scope parity with linearPattern — optional toolFeatures subtree
        // patterns that body and unions onto the base (not the whole solid).
        const tools = f.data?.["toolFeatures"] as EditorFeature[] | undefined;
        if (Array.isArray(tools) && tools.length > 0) {
          const seed = rebuildDocument(oc, { features: tools, params: doc.params ?? {} });
          if (!seed) throw new Error(`feature '${f.id}' (circularPattern): tool body is empty`);
          const copies = circularPattern(oc, seed, origin, axis, count, angle);
          seed.delete();
          try {
            let acc: Solid = base;
            let owned: Solid | null = null;
            for (const c of copies) {
              const r = union(oc, acc, c);
              if (owned) owned.delete();
              if (!r.ok)
                throw new Error(`feature '${f.id}' (circularPattern tool union): ${r.error}`);
              releaseBooleanHistory(r);
              owned = r.solid;
              acc = r.solid;
            }
            replace(acc);
            owned = null;
          } finally {
            for (const c of copies) c.delete();
          }
        } else {
          const copies = circularPattern(oc, base, origin, axis, count, angle);
          try {
            replace(fusePatternCopies(oc, copies, f.id));
          } finally {
            for (const c of copies) c.delete();
          }
        }
        break;
      }
      case "pathPattern": {
        // §13.2 patternAlongPath — N copies at uniform arc-length samples along a
        // spine (SpinePath polyline/path, or model pathEdges like sweep). Optional
        // toolFeatures scopes the pattern to a feature-subtree (linearPattern T21).
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (pathPattern): no solid`);
        const count = Math.round(num(f, "count"));
        const align = f.data?.["align"] === true;
        const path = f.data?.["path"] as SpinePath | undefined;
        const pathEdges = f.data?.["pathEdges"] as EdgeRef[] | undefined;
        if (!path && !(pathEdges && pathEdges.length > 0)) {
          throw new Error(`feature '${f.id}' (pathPattern): no path (data.path or data.pathEdges)`);
        }
        const tools = f.data?.["toolFeatures"] as EditorFeature[] | undefined;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        let seed: Solid = base;
        let seedOwned = false;
        if (hasTools) {
          const built = rebuildDocument(oc, { features: tools!, params: doc.params ?? {} });
          if (!built) throw new Error(`feature '${f.id}' (pathPattern): tool body is empty`);
          seed = built;
          seedOwned = true;
        }
        let copies: Solid[];
        try {
          copies = pathEdges?.length
            ? pathPatternAlongPickedEdges(oc, base, seed, pathEdges, count, align, f.id)
            : patternAlongPath(oc, seed, path!, count, align ? { align: true } : undefined);
        } finally {
          if (seedOwned) seed.delete();
        }
        try {
          if (hasTools) {
            let acc: Solid = base;
            let owned: Solid | null = null;
            for (const c of copies) {
              const r = union(oc, acc, c);
              if (owned) owned.delete();
              if (!r.ok) throw new Error(`feature '${f.id}' (pathPattern tool union): ${r.error}`);
              releaseBooleanHistory(r);
              owned = r.solid;
              acc = r.solid;
            }
            replace(acc);
            owned = null;
          } else {
            replace(fusePatternCopies(oc, copies, f.id));
          }
        } finally {
          for (const c of copies) c.delete();
        }
        break;
      }
      case "split": {
        // §13.2 split — keep BOTH sides of a plane (or solid tool) cut as a
        // multi-body compound. Tool: data.plane {origin, normal, xAxis?} or
        // data.toolFeatures (solid knife, same as boolean).
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (split): no solid`);
        const toolFeatures = f.data?.["toolFeatures"] as EditorFeature[] | undefined;
        let parts: Solid[] = [];
        let ownedTool: Solid | null = null;
        try {
          if (Array.isArray(toolFeatures) && toolFeatures.length > 0) {
            ownedTool = rebuildDocument(oc, {
              features: toolFeatures,
              params: doc.params ?? {},
            });
            if (!ownedTool) throw new Error(`feature '${f.id}' (split): tool body is empty`);
            parts = split(oc, base, ownedTool);
          } else if (f.data?.["plane"]) {
            parts = split(oc, base, planeFromFeatureData(f.data, f.id, "split"));
          } else {
            throw new Error(
              `feature '${f.id}' (split): need data.plane (origin+normal) or data.toolFeatures`,
            );
          }
          if (parts.length === 1) {
            replace(parts[0]!);
            parts = []; // ownership transferred to the accumulator
          } else {
            // makeCompound does not consume parts — free them after replace.
            const compound = makeCompound(oc, parts);
            replace(compound);
            for (const p of parts) p.delete();
            parts = [];
          }
        } finally {
          for (const p of parts) p.delete();
          if (ownedTool) ownedTool.delete();
        }
        break;
      }
      case "section": {
        // §13.2 sectionCurves — body ∩ plane as a curve compound (Solid of edges).
        // Terminal analysis feature: replaces the solid with the section result.
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (section): no solid`);
        if (!f.data?.["plane"]) {
          throw new Error(`feature '${f.id}' (section): need data.plane (origin+normal)`);
        }
        replace(sectionCurves(oc, base, planeFromFeatureData(f.data, f.id, "section")));
        break;
      }
      case "boolean": {
        // Combine the base body with a SECOND modelled body via
        // union/subtract/intersect (FR-31). The tool body is a full feature
        // subtree (`data.toolFeatures`) evaluated independently — so the operand
        // is a real modelled body (box, sketch→extrude, revolve, …), not just a
        // primitive. A legacy inline box tool (params dx/dy/dz + tx/ty/tz) is the
        // fallback when no subtree is given.
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (boolean): no base body`);
        const op = (f.data?.["op"] as string) ?? "union";
        const toolFeatures = f.data?.["toolFeatures"] as EditorFeature[] | undefined;
        let tool: Solid;
        if (Array.isArray(toolFeatures) && toolFeatures.length > 0) {
          // R6: forward the REAL global params so a tool-subtree feature's exprs
          // resolve (was `{}`, which left subtree exprs unable to see doc.params).
          const built = rebuildDocument(oc, { features: toolFeatures, params: doc.params ?? {} });
          if (!built) throw new Error(`feature '${f.id}' (boolean): tool body is empty`);
          tool = built;
        } else {
          tool = makeBoxAt(
            oc,
            [opt(f, "tx", 0), opt(f, "ty", 0), opt(f, "tz", 0)],
            num(f, "dx"),
            num(f, "dy"),
            num(f, "dz"),
          );
        }
        try {
          // §13.1: boolean returns optional history; thread faceIdRemap + rewrite
          // later FaceRef disambiguators when history is present, then free it.
          replace(runDocumentBoolean(oc, doc, f.id, base, tool, op));
        } finally {
          tool.delete();
        }
        break;
      }
      case "importStep": {
        // Imported STEP as a base body (FR-42). The STEP text persists in the
        // feature's data, so the import reloads + rebuilds reproducibly. A
        // crash-recovery snapshot may carry `data.stepRef` (a content-addressed
        // reference into the recovery payload store, Review #13) instead of the
        // inline text; hydrateRecovery re-inflates it before load, so an
        // unresolved ref here means the stored payload was lost — fail loudly,
        // never fabricate geometry.
        const text = f.data?.["step"];
        if (typeof text !== "string" || text.length === 0) {
          const ref = f.data?.["stepRef"] as { hash?: unknown } | undefined;
          if (ref && typeof ref === "object" && typeof ref.hash === "string") {
            throw new Error(
              `feature '${f.id}' (importStep): the imported STEP payload (ref ` +
                `${ref.hash.slice(0, 12)}…) is unavailable — the document was ` +
                `recovered without its stored import payload. Re-import the ` +
                `original STEP file.`,
            );
          }
          throw new Error(`feature '${f.id}' (importStep): missing STEP text`);
        }
        replace(importStep(oc, text));
        break;
      }
      case "importIges": {
        const text = f.data?.["iges"];
        if (typeof text !== "string" || text.length === 0) {
          const ref = f.data?.["igesRef"] as { hash?: unknown } | undefined;
          if (ref && typeof ref === "object" && typeof ref.hash === "string") {
            throw new Error(
              `feature '${f.id}' (importIges): the imported IGES payload (ref ` +
                `${ref.hash.slice(0, 12)}…) is unavailable — the document was ` +
                `recovered without its stored import payload. Re-import the ` +
                `original IGES file.`,
            );
          }
          throw new Error(`feature '${f.id}' (importIges): missing IGES text`);
        }
        replace(importIges(oc, text));
        break;
      }
      case "freeform": {
        // §15 freeform NURBS surface body. Feature data stores a NurbsSurface
        // JSON control net (or a plane/cylinder/sphere kind + params that
        // regenerates one). Rebuild samples the pure-TS surface onto a
        // rectangular point grid and commits via surfaceFromPoints → face
        // Solid so the existing tessellateTagged viewport path lights up.
        // Full Geom_BSplineSurface pole commit (Lane A(b)) is not required yet.
        const surf = resolveFreeformSurface(f);
        const resU = Math.max(2, Math.floor(opt(f, "resU", 12)));
        const resV = Math.max(2, Math.floor(opt(f, "resV", 12)));
        const face = freeformSurfaceToFace(oc, surf, resU, resV);
        // Sheet body: default `op: "new"` when a solid already exists so a
        // freeform does not boolean-union a face into a volume body.
        if (currentSolid() && f.data?.["op"] === undefined) {
          replace(
            combinePrimitive(oc, currentSolid(), face, { ...f, data: { ...f.data, op: "new" } }),
          );
        } else {
          replace(combinePrimitive(oc, currentSolid(), face, f));
        }
        break;
      }
      case "placement":
        // A body placement (FR-11) is a scene-level pose, not a geometry op —
        // the viewport applies it to the part group, lowering composes it into
        // the synthesized body0's sim pose, and file export bakes it into the
        // solid (geometry.worker.core.ts, §2.11.1) — so the kernel REBUILD
        // always leaves geometry in the local frame.
        break;
      default:
        throw new Error(`unsupported feature type '${f.type}'`);
    }
  }
}

// ── Freeform helpers (§15) ────────────────────────────────────────────────────

/** Parse/validate a NurbsSurface stored in freeform feature data. */
function parseNurbsSurfaceJson(raw: unknown, featureId: string): NurbsSurface {
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `feature '${featureId}' (freeform): data.surface must be a NurbsSurface object`,
    );
  }
  const s = raw as Record<string, unknown>;
  const degU = s["degU"];
  const degV = s["degV"];
  const knotsU = s["knotsU"];
  const knotsV = s["knotsV"];
  const controlNet = s["controlNet"];
  if (typeof degU !== "number" || typeof degV !== "number") {
    throw new Error(`feature '${featureId}' (freeform): surface.degU/degV required`);
  }
  if (!Array.isArray(knotsU) || !Array.isArray(knotsV) || !Array.isArray(controlNet)) {
    throw new Error(
      `feature '${featureId}' (freeform): surface needs knotsU/knotsV/controlNet arrays`,
    );
  }
  const net: Vec3[][] = (controlNet as unknown[]).map((row, i) => {
    if (!Array.isArray(row)) {
      throw new Error(`feature '${featureId}' (freeform): controlNet[${i}] is not a row`);
    }
    return row.map((p, j): Vec3 => {
      if (!Array.isArray(p) || p.length < 3) {
        throw new Error(
          `feature '${featureId}' (freeform): controlNet[${i}][${j}] must be [x,y,z]`,
        );
      }
      return [Number(p[0]), Number(p[1]), Number(p[2])];
    });
  });
  const weightsRaw = s["weights"];
  const weights = Array.isArray(weightsRaw)
    ? (weightsRaw as unknown[]).map((row) => {
        if (!Array.isArray(row)) {
          throw new Error(`feature '${featureId}' (freeform): weights must be a rectangular grid`);
        }
        return row.map((w) => Number(w));
      })
    : undefined;
  const surf = makeNurbsSurface({
    degU: Math.floor(degU),
    degV: Math.floor(degV),
    knotsU: (knotsU as number[]).map(Number),
    knotsV: (knotsV as number[]).map(Number),
    controlNet: net,
    ...(weights ? { weights } : {}),
  });
  try {
    validateSurface(surf);
  } catch (err) {
    throw new Error(
      `feature '${featureId}' (freeform): invalid surface — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return surf;
}

/**
 * Resolve the freeform surface for a feature.
 *
 * Primitive kinds regenerate from params when the required sizes are present
 * (so Properties edits of radius/size stay parametric). Otherwise data.surface
 * (NurbsSurface JSON) is the rebuild source of truth — the custom / control-net
 * path and AI-authored freeform nets.
 */
function resolveFreeformSurface(f: EditorFeature): NurbsSurface {
  const kind = f.data?.["kind"];
  const origin: Vec3 = [opt(f, "ox", 0), opt(f, "oy", 0), opt(f, "oz", 0)];
  const has = (key: string): boolean =>
    typeof f.params?.[key] === "number" && Number.isFinite(f.params[key]);

  if (kind === "plane" && has("uSize") && has("vSize")) {
    const uDirRaw = f.data?.["uDir"];
    const vDirRaw = f.data?.["vDir"];
    const uDir: Vec3 =
      Array.isArray(uDirRaw) && uDirRaw.length === 3
        ? [Number(uDirRaw[0]), Number(uDirRaw[1]), Number(uDirRaw[2])]
        : [1, 0, 0];
    const vDir: Vec3 =
      Array.isArray(vDirRaw) && vDirRaw.length === 3
        ? [Number(vDirRaw[0]), Number(vDirRaw[1]), Number(vDirRaw[2])]
        : [0, 1, 0];
    return planeSurface(origin, uDir, vDir, num(f, "uSize"), num(f, "vSize"));
  }
  if (kind === "cylinder" && has("radius") && has("height")) {
    const axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 0), opt(f, "az", 1)];
    return cylinderSurface(origin, axis, num(f, "radius"), num(f, "height"));
  }
  if (kind === "sphere" && has("radius")) {
    return sphereSurface(origin, num(f, "radius"));
  }

  const surfaceRaw = f.data?.["surface"];
  if (surfaceRaw !== undefined && surfaceRaw !== null) {
    return parseNurbsSurfaceJson(surfaceRaw, f.id);
  }
  throw new Error(
    `feature '${f.id}' (freeform): need data.surface (NurbsSurface JSON) or data.kind ` +
      `(plane|cylinder|sphere) with size params`,
  );
}

/**
 * Sample a pure-TS freeform surface onto a rectangular point grid and fit an
 * OCCT B-spline face via surfaceFromPoints — the temporary solid path until a
 * full Geom_BSplineSurface pole commit lands.
 */
function freeformSurfaceToFace(oc: Occt, surf: NurbsSurface, resU: number, resV: number): Solid {
  const { u0, u1, v0, v1 } = freeformDomain(surf);
  const nu = Math.max(2, resU);
  const nv = Math.max(2, resV);
  const grid: Vec3[][] = [];
  for (let i = 0; i < nu; i++) {
    const u = u0 + ((u1 - u0) * i) / (nu - 1);
    const row: Vec3[] = [];
    for (let j = 0; j < nv; j++) {
      const v = v0 + ((v1 - v0) * j) / (nv - 1);
      row.push(evaluateFreeform(surf, u, v));
    }
    grid.push(row);
  }
  const degU = Math.max(1, Math.min(surf.degU, nu - 1));
  const degV = Math.max(1, Math.min(surf.degV, nv - 1));
  return surfaceFromPoints(oc, grid, { degU, degV });
}

/**
 * A message that ALWAYS names the offending feature.
 *
 * Kernel errors raised by this module already carry a `feature '<id>' (<type>)`
 * prefix; raw OCCT `Standard_Failure` throws (a plain pointer number) carry
 * nothing at all — which is how the UI ended up rendering "rebuild failed:
 * undefined" and "rebuild failed: 5286968". Prefixing here means the caller
 * never has to parse a message to find out what broke.
 */
function featureErrorMessage(f: EditorFeature, err: unknown): string {
  const raw = describeOcctError(err);
  return raw.includes(`feature '${f.id}'`) ? raw : `feature '${f.id}' (${f.type}): ${raw}`;
}

/**
 * Evaluate `doc` into a Solid, FAILING FAST on the first bad feature.
 *
 * Kept for internal sub-builds (boolean tool subtrees, pattern tool features)
 * and the headless CLI, where a partially-built tool body must never silently
 * become geometry. The interactive editor uses {@link rebuildDocumentIsolated}.
 */
export function rebuildDocument(oc: Occt, doc: CadDocument): Solid | null {
  return evaluateDocument(oc, doc, false).solid;
}

/**
 * Evaluate `doc`, ISOLATING per-feature failures: a feature that throws is
 * reported in `statuses` and skipped, and the last good solid passes through.
 * One impossible fillet no longer blanks the entire model (FR-24).
 */
export function rebuildDocumentIsolated(oc: Occt, doc: CadDocument): IsolatedBuild {
  return evaluateDocument(oc, doc, true);
}

/** A built part: its tagged mesh plus the solid's density-free mass properties
 * (volume + centroid), read off the same build so the panel needs no rebuild. */
export interface BuiltPart {
  mesh: TaggedMesh;
  /** Solid volume in m³ (summed across every body). */
  volume: number;
  /** Geometric centre of mass (centroid) in SI metres. */
  com: [number, number, number];
  /** Each BODY's own volume in m³ (§2.4 multi-body). One entry for a plain
   * solid, N for a compound — without this a two-body document is
   * indistinguishable from a single body in every readout. */
  bodyVolumes: number[];
}

/** Each body's own volume, freeing the temporary per-body handles (§2.4). */
function perBodyVolumes(oc: Occt, solid: Solid): number[] {
  const bodies = bodiesOf(oc, solid);
  try {
    return bodies.map((b) => b.volume());
  } finally {
    for (const b of bodies) b.delete();
  }
}

/** Rebuild + tag the document AND read the solid's volume/centroid before it is
 * disposed (FR-6 + mass-properties readout); null if the document has no geometry. */
export function rebuildTaggedWithProps(
  oc: Occt,
  doc: CadDocument,
  opts: TessellateOptions,
): BuiltPart | null {
  const solid = rebuildDocument(oc, doc);
  if (!solid) return null;
  try {
    const mesh = tessellateTagged(oc, solid, opts);
    return {
      mesh,
      volume: solid.volume(),
      com: solid.centreOfMass(),
      bodyVolumes: perBodyVolumes(oc, solid),
    };
  } finally {
    solid.delete();
  }
}

/** Rebuild + tag the document's tessellation (FR-6); null if no geometry. */
export function rebuildTagged(
  oc: Occt,
  doc: CadDocument,
  opts: TessellateOptions,
): TaggedMesh | null {
  return rebuildTaggedWithProps(oc, doc, opts)?.mesh ?? null;
}

/** An isolating build: the geometry that survived (null if none) + every feature's fate. */
export interface BuiltDocument {
  readonly part: BuiltPart | null;
  readonly statuses: FeatureBuildStatus[];
}

/**
 * The INTERACTIVE editor's build: isolates per-feature failures and always
 * reports every feature's fate, so the UI can badge the offending feature
 * (FR-24) without parsing a message, and can still render whatever geometry
 * survived. Unlike {@link rebuildTaggedWithProps} this never throws for a bad
 * feature, and it returns statuses even when the document builds no geometry
 * at all — the failure list is exactly what the user needs in that case.
 */
export function buildDocumentIsolated(
  oc: Occt,
  doc: CadDocument,
  opts: TessellateOptions,
): BuiltDocument {
  const { solid, statuses } = rebuildDocumentIsolated(oc, doc);
  if (!solid) return { part: null, statuses };
  try {
    const mesh = tessellateTagged(oc, solid, opts);
    return {
      part: {
        mesh,
        volume: solid.volume(),
        com: solid.centreOfMass(),
        bodyVolumes: perBodyVolumes(oc, solid),
      },
      statuses,
    };
  } catch (err) {
    // Tessellation itself failed: the features are fine, the mesh is not. Report
    // it rather than throwing away the whole build response.
    return {
      part: null,
      statuses: [...statuses, { featureId: "", status: "error", message: describeOcctError(err) }],
    };
  } finally {
    solid.delete();
  }
}
