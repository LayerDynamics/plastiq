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
  resolveEdgeDirection,
  importStep,
  intersect,
  linearPattern,
  loft,
  makeBox,
  makeBoxAt,
  mirror,
  offsetPlane,
  planeXY,
  revolve,
  sweep,
  type DatumPlane,
  type SpinePath,
  rotate,
  shell,
  Sketch,
  subtract,
  tessellateTagged,
  translate,
  union,
  type EdgeRef,
  type FaceRef,
  type Occt,
  type Solid,
  type TaggedMesh,
  type TessellateOptions,
} from "@plastiq/cad";
import type { CadDocument, EditorFeature } from "../store/types.js";
import { extractProfile, isProfile, type Profile } from "../sketch/profile.js";
import type { SketchModel } from "../sketch/model.js";

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
 * Build a kernel Sketch on the XY datum from a derived editor profile. A circle
 * becomes a true curved edge (real cylinder on extrude); a loop becomes its
 * line/arc segment chain.
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

/**
 * Fuse pattern copies into one independent solid (the caller still owns + deletes
 * the input `copies`). Always returns a fresh solid, even for a single copy.
 */
function unionAll(oc: Occt, copies: readonly Solid[], featureId: string): Solid {
  if (copies.length === 0) throw new Error(`feature '${featureId}': pattern produced no copies`);
  let acc = translate(oc, copies[0]!, [0, 0, 0]); // own an independent copy
  for (let i = 1; i < copies.length; i++) {
    const r = union(oc, acc, copies[i]!);
    acc.delete();
    if (!r.ok) throw new Error(`feature '${featureId}' (pattern union): ${r.error}`);
    acc = r.solid;
  }
  return acc;
}

/**
 * Evaluate `doc`'s feature tree into a single Solid (or null if it produces no
 * geometry). Throws on the first unrecoverable feature error; the caller
 * (worker/tree) attributes it to the offending feature.
 */
export function rebuildDocument(oc: Occt, doc: CadDocument): Solid | null {
  let solid: Solid | null = null;
  let profile: Profile | null = null;

  const replace = (next: Solid): void => {
    solid?.delete();
    solid = next;
  };

  for (const f of doc.features) {
    if (f.suppressed) continue;
    switch (f.type) {
      case "box":
        replace(makeBox(oc, num(f, "dx"), num(f, "dy"), num(f, "dz")));
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
        profile = prof;
        break;
      }
      case "extrude": {
        if (!profile) throw new Error(`feature '${f.id}' (extrude): no sketch profile upstream`);
        const sk = profileSketch(profile);
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
          replace(extrude(oc, sk, num(f, "height"), { back: opt(f, "back", 0), direction }));
        }
        break;
      }
      case "revolve": {
        if (!profile) throw new Error(`feature '${f.id}' (revolve): no sketch profile upstream`);
        // Revolve the active profile about an axis (default: world Y through
        // origin) by `angle` radians (FR-29).
        const angle = num(f, "angle");
        const axis: [number, number, number] = [opt(f, "ax", 0), opt(f, "ay", 1), opt(f, "az", 0)];
        replace(revolve(oc, profileSketch(profile), [0, 0, 0], axis, angle));
        break;
      }
      case "loft": {
        // Loft through ≥2 section profiles, each on an offset XY plane (FR-32).
        const sections = f.data?.["sections"] as { profile: Profile; z: number }[] | undefined;
        if (!Array.isArray(sections) || sections.length < 2) {
          throw new Error(`feature '${f.id}' (loft): needs ≥2 section profiles`);
        }
        const sketches = sections.map((s) => profileSketch(s.profile, offsetPlane(planeXY(), s.z)));
        replace(loft(oc, sketches, { ruled: Boolean(f.data?.["ruled"]) }));
        break;
      }
      case "sweep": {
        // Sweep a profile along a polyline/arc path (FR-32).
        const prof = f.data?.["profile"] as Profile | undefined;
        const path = f.data?.["path"] as SpinePath | undefined;
        if (!isProfile(prof)) throw new Error(`feature '${f.id}' (sweep): no profile`);
        if (!path) throw new Error(`feature '${f.id}' (sweep): no path`);
        replace(sweep(oc, profileSketch(prof), path));
        break;
      }
      case "cut": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (cut): no solid to cut into`);
        if (!profile) throw new Error(`feature '${f.id}' (cut): no sketch profile upstream`);
        // Subtract the active profile, extruded `depth`, from the current solid
        // (a pocket/through-cut; FR-29).
        const tool = extrude(oc, profileSketch(profile), num(f, "depth"));
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
        const edges = (f.data?.["edges"] ?? []) as EdgeRef[];
        if (edges.length === 0) throw new Error(`feature '${f.id}' (fillet): no edges selected`);
        // EdgeRefs re-resolve against THIS rebuild's topology (FR-16/R2).
        replace(fillet(oc, base, edges, num(f, "radius")));
        break;
      }
      case "chamfer": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (chamfer): no solid to chamfer`);
        const edges = (f.data?.["edges"] ?? []) as EdgeRef[];
        if (edges.length === 0) throw new Error(`feature '${f.id}' (chamfer): no edges selected`);
        replace(chamfer(oc, base, edges, num(f, "distance")));
        break;
      }
      case "shell": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (shell): no solid to shell`);
        const faces = (f.data?.["faces"] ?? []) as FaceRef[];
        if (faces.length === 0) throw new Error(`feature '${f.id}' (shell): no faces selected`);
        replace(shell(oc, base, faces, num(f, "thickness")));
        break;
      }
      case "draft": {
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (draft): no solid to draft`);
        const face = f.data?.["face"] as FaceRef | undefined;
        if (!face) throw new Error(`feature '${f.id}' (draft): no face selected`);
        const vec = (key: string, d: Vec3): Vec3 => {
          const v = f.data?.[key];
          return Array.isArray(v) && v.length === 3
            ? [Number(v[0]), Number(v[1]), Number(v[2])]
            : d;
        };
        replace(
          draft(oc, base, {
            face,
            pullDirection: vec("pull", [0, 0, 1]),
            neutralOrigin: vec("neutralOrigin", [0, 0, 0]),
            neutralNormal: vec("neutralNormal", [0, 0, 1]),
            angle: num(f, "angle"),
          }),
        );
        break;
      }
      case "transform": {
        // Baked rigid move of the current solid (FR-31; distinct from the M1.3
        // scene-level "placement"). Rotate (if any) about an axis, then translate.
        const base = solid;
        if (!base) throw new Error(`feature '${f.id}' (transform): no solid`);
        const angle = opt(f, "angle", 0);
        const moved = translate(oc, base, [opt(f, "tx", 0), opt(f, "ty", 0), opt(f, "tz", 0)]);
        if (angle !== 0) {
          const axis: Vec3 = [opt(f, "ax", 0), opt(f, "ay", 0), opt(f, "az", 1)];
          const rot = rotate(oc, moved, [0, 0, 0], axis, angle);
          moved.delete();
          replace(rot);
        } else {
          replace(moved);
        }
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
        const copies = linearPattern(oc, base, dir, num(f, "spacing"), Math.round(num(f, "count")));
        try {
          replace(unionAll(oc, copies, f.id));
        } finally {
          for (const c of copies) c.delete();
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
          replace(unionAll(oc, copies, f.id));
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
        // feature's data, so the import reloads + rebuilds reproducibly.
        const text = f.data?.["step"];
        if (typeof text !== "string" || text.length === 0) {
          throw new Error(`feature '${f.id}' (importStep): missing STEP text`);
        }
        replace(importStep(oc, text));
        break;
      }
      case "placement":
        // A body placement (FR-11) is a scene-level pose, not a geometry op —
        // it is applied to the part group in the viewport and composed into the
        // sim manifest at export, so the kernel rebuild leaves geometry local.
        break;
      default:
        throw new Error(`unsupported feature type '${f.type}'`);
    }
  }
  return solid;
}

/** Rebuild + tag the document's tessellation (FR-6); null if no geometry. */
export function rebuildTagged(
  oc: Occt,
  doc: CadDocument,
  opts: TessellateOptions,
): TaggedMesh | null {
  const solid = rebuildDocument(oc, doc);
  if (!solid) return null;
  try {
    return tessellateTagged(oc, solid, opts);
  } finally {
    solid.delete();
  }
}
