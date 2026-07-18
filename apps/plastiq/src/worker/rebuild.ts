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
  chamfer,
  circularPattern,
  cut,
  draft,
  extrude,
  extrudeToFace,
  fillet,
  describeOcctError,
  resolveEdgeDirection,
  resolveEdgeAxis,
  resolveEdgeRef,
  buildWireFromEdges,
  sweepAlongWire,
  importStep,
  intersect,
  linearPattern,
  loft,
  makeBox,
  makeBoxAt,
  makeCylinder,
  makeSphere,
  makeCone,
  makeTorus,
  makeCompound,
  type AxisPlacement,
  mirror,
  offsetPlane,
  faceDatumPlane,
  resolveFaceRef,
  resolveSelector,
  isSelector,
  planeXY,
  revolve,
  sweep,
  type SweepOptions,
  type DatumPlane,
  type SpinePath,
  rotate,
  shell,
  Sketch,
  subtract,
  tessellateTagged,
  translate,
  union,
  unionAll,
  type ShellOptions,
  type EdgeRef,
  type FaceRef,
  type Occt,
  type Solid,
  type TaggedMesh,
  type TessellateOptions,
} from "@plastiq/cad";
import type { TopoDS_Edge } from "opencascade.js";
import type { CadDocument, EditorFeature } from "../store/types.js";
import { extractProfile, isProfile, type Profile } from "../sketch/profile.js";
import { resolveSketchPlane } from "./sketchPlane.js";
import { isFaceSketchPlane, type SketchModel, type SketchPlaneSpec } from "../sketch/model.js";

/** A 3-vector (the kernel's Vec3 shape; not re-exported from the root). */
type Vec3 = [number, number, number];

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
  return r.solid;
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
    return r.solid;
  } finally {
    tool.delete();
  }
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

/**
 * Evaluate `doc`'s feature tree into a single Solid (or null if it produces no
 * geometry). Throws on the first unrecoverable feature error; the caller
 * (worker/tree) attributes it to the offending feature.
 */
type ActiveSketch = { profile: Profile; plane: DatumPlane };

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

/** Per-feature outcome of a rebuild pass (SPEC-5 FR-24 timeline semantics). */
export interface FeatureBuildStatus {
  readonly featureId: string;
  readonly status: "ok" | "error" | "suppressed";
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
      buildFeature(f);
      statuses.push({ featureId: f.id, status: "ok" });
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
            makeCone(oc, num(f, "radius1"), num(f, "radius2"), num(f, "height"), primitivePlacement(f)),
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
        const entry: ActiveSketch = { profile: prof, plane: sketchPlane };
        sketches.set(f.id, entry);
        lastSketch = entry;
        break;
      }
      case "extrude": {
        const activeSketch = sketchForFeature(f, sketches, lastSketch, allFeatureIds, sketchFeatureIds);
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
        if (toFace) {
          const base = solid;
          if (!base) throw new Error(`feature '${f.id}' (extrude to face): no upstream body`);
          const pad = extrudeToFace(oc, sk, base, toFace, direction ? { direction } : {});
          try {
            const r = union(oc, base, pad);
            if (!r.ok) throw new Error(`feature '${f.id}' (extrude to face): ${r.error}`);
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
          const back = opt(f, "back", 0);
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
          const op = f.data?.["op"];
          const join =
            solid != null && (op === "join" || op !== "new");
          if (join && solid) {
            try {
              const r = union(oc, solid, pad);
              if (!r.ok) throw new Error(`feature '${f.id}' (extrude join): ${r.error}`);
              replace(r.solid);
            } finally {
              pad.delete();
            }
          } else {
            // §2.4: `op:"new"` keeps the prior geometry as a SEPARATE body.
            replace(solid ? newBody(oc, solid, pad) : pad);
          }
        }
        break;
      }
      case "revolve": {
        const activeSketch = sketchForFeature(f, sketches, lastSketch, allFeatureIds, sketchFeatureIds);
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
          if (!solid)
            throw new Error(`feature '${f.id}' (revolve): no body for the axis edge`);
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
                : profileSketch({ kind: "loop", start: h.start, segments: h.segments }, activeSketch.plane);
            const tool = revolve(oc, holeSk, origin, axis, angle);
            try {
              const r = subtract(oc, body, tool);
              body.delete();
              if (!r.ok) throw new Error(`feature '${f.id}' (revolve hole): ${r.error}`);
              body = r.solid;
            } finally {
              tool.delete();
            }
          }
        }
        // Join-by-default when a solid exists (parity with extrude C1/C2); op:"new" replaces.
        const op = f.data?.["op"];
        const join = solid != null && (op === "join" || op !== "new");
        if (join && solid) {
          try {
            const r = union(oc, solid, body);
            if (!r.ok) throw new Error(`feature '${f.id}' (revolve join): ${r.error}`);
            replace(r.solid);
          } finally {
            body.delete();
          }
        } else {
          // §2.4: `op:"new"` keeps the prior geometry as a SEPARATE body.
          replace(solid ? newBody(oc, solid, body) : body);
        }
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
          const op = f.data?.["op"];
          const join = solid != null && (op === "join" || op !== "new");
          if (join && solid) {
            try {
              const r = union(oc, solid, body);
              if (!r.ok) throw new Error(`feature '${f.id}' (loft join): ${r.error}`);
              replace(r.solid);
            } finally {
              body.delete();
            }
          } else {
            // §2.4: `op:"new"` keeps the prior geometry as a SEPARATE body.
            replace(solid ? newBody(oc, solid, body) : body);
          }
        }
        break;
      }
      case "sweep": {
        // Sweep a profile along a polyline or mixed line/arc path (FR-32 / G4).
        // The profile plane is taken from data.plane (explicit), else the active
        // sketch's plane, else world-XY — so a non-XY profile is not forced onto
        // XY (G3).
        const prof = f.data?.["profile"] as Profile | undefined;
        const path = f.data?.["path"] as SpinePath | undefined;
        // A spine picked on the model (FR-32): persistent EdgeRefs re-resolved
        // against the current body each rebuild, so the swept pipe FOLLOWS its
        // edges when an upstream parameter moves them. Takes precedence over a
        // baked `path`, which stays the authoring surface for a typed spine.
        const pathEdges = f.data?.["pathEdges"] as EdgeRef[] | undefined;
        if (!isProfile(prof)) throw new Error(`feature '${f.id}' (sweep): no profile`);
        if (!path && !(pathEdges && pathEdges.length > 0)) {
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
          const body = pathEdges?.length
            ? sweepAlongPickedEdges(
                oc,
                currentSolid(),
                profileSketch(prof, sweepPlane),
                pathEdges,
                f.id,
                sweepOpts,
              )
            : sweep(oc, profileSketch(prof, sweepPlane), path!, sweepOpts);
          const op = f.data?.["op"];
          const join = solid != null && (op === "join" || op !== "new");
          if (join && solid) {
            try {
              const r = union(oc, solid, body);
              if (!r.ok) throw new Error(`feature '${f.id}' (sweep join): ${r.error}`);
              replace(r.solid);
            } finally {
              body.delete();
            }
          } else {
            // §2.4: `op:"new"` keeps the prior geometry as a SEPARATE body.
            replace(solid ? newBody(oc, solid, body) : body);
          }
        }
        break;
      }
      case "cut": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (cut): no solid to cut into`);
        const activeSketch = sketchForFeature(f, sketches, lastSketch, allFeatureIds, sketchFeatureIds);
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
          fillet(oc, base, edges, num(f, "radius"), Number.isFinite(endR) ? { endRadius: endR } : undefined),
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
          chamfer(
            oc,
            base,
            edges,
            num(f, "distance"),
            Number.isFinite(d2) && chFace
              ? { distance2: d2, face: chFace }
              : undefined,
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
        replace(shell(oc, base, faces, num(f, "thickness"), shellOpts));
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
        // Apply draft sequentially per face; each step re-bases on the prior solid
        // so multi-face mold draft is expressible without a kernel multi-Add API.
        let current: Solid = base;
        let owned: Solid | null = null;
        try {
          for (const face of faces) {
            const next = draft(oc, current, {
              face,
              pullDirection: pull,
              neutralOrigin,
              neutralNormal,
              angle,
            });
            if (owned) owned.delete();
            owned = next;
            current = next;
          }
          replace(current);
          owned = null; // ownership passed via replace
        } finally {
          owned?.delete();
        }
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
              if (!r.ok) throw new Error(`feature '${f.id}' (linearPattern tool union): ${r.error}`);
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
        const copies = circularPattern(
          oc,
          base,
          origin,
          axis,
          Math.round(num(f, "count")),
          opt(f, "angle", Math.PI * 2),
        );
        try {
          replace(fusePatternCopies(oc, copies, f.id));
        } finally {
          for (const c of copies) c.delete();
        }
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
          const built = rebuildDocument(oc, { features: toolFeatures, params: {} });
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
          const r =
            op === "subtract"
              ? subtract(oc, base, tool)
              : op === "intersect"
                ? intersect(oc, base, tool)
                : union(oc, base, tool);
          if (!r.ok) throw new Error(`feature '${f.id}' (boolean ${op}): ${r.error}`);
          replace(r.solid);
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
  /** Solid volume in m³. */
  volume: number;
  /** Geometric centre of mass (centroid) in SI metres. */
  com: [number, number, number];
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
    return { mesh, volume: solid.volume(), com: solid.centreOfMass() };
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
      part: { mesh, volume: solid.volume(), com: solid.centreOfMass() },
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
