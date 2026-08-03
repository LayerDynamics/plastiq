// SPEC-6 R0 — the AI authoring contract + the mm↔SI conversion choke-point.
//
// The AI authors a document in HUMAN units (millimetres / degrees); the kernel's
// CadDocument is SI (metres / radians). `toCadDocument` is the single place that
// scales; `toAuthoringDoc` is its exact inverse (used for edit-mode context, FR-6a).
// The feature set + the per-key unit classification mirror, one-to-one, the cases
// in apps/plastiq/src/worker/rebuild.ts — that file is the source of truth for what
// each feature consumes. zod validates the STRUCTURE (it cannot see units); units
// are a semantic contract enforced here + in the system prompt.

import { z } from "zod";
import { mm, deg, toMm, toDeg } from "@plastiq/cad";
import type { CadDocument, EditorFeature } from "../../store/types.js";
import { LENGTH_PARAMS, ANGLE_PARAMS } from "../../store/featureUnits.js";

// ── Authoring types (structurally identical to the editor's EditorFeature; the
//    only difference from a CadDocument is that numbers are in mm/deg) ───────────

export interface AuthoringFeature {
  id: string;
  type: string;
  name?: string;
  deps?: string[];
  params?: Record<string, number>;
  data?: Record<string, unknown>;
  suppressed?: boolean;
}

export interface AuthoringDocument {
  features: AuthoringFeature[];
  params: Record<string, number>;
  assembly?: unknown;
}

// ── zod building blocks ─────────────────────────────────────────────────────────

const vec2 = z.tuple([z.number(), z.number()]);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const numParams = z.record(z.string(), z.number());

const faceRef = z.object({ normal: vec3, centroid: vec3.optional() });
const edgeRef = z.object({ faceNormals: z.tuple([vec3, vec3]), midpoint: vec3.optional() });

const profileSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: vec2 }),
  z.object({ kind: z.literal("arc"), through: vec2, to: vec2 }),
  z.object({ kind: z.literal("spline"), through: z.array(vec2), to: vec2 }),
]);
const profile = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), center: vec2, radius: z.number() }),
  z.object({ kind: z.literal("loop"), start: vec2, segments: z.array(profileSegment) }),
]);

const datumPlaneId = z.enum(["XY", "XZ", "YZ"]);
const sketchPlaneSpec = z.union([
  z.object({ base: datumPlaneId, offset: z.number() }),
  z.object({ kind: z.literal("face"), face: faceRef, offset: z.number() }),
]);
const spineSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("line"), to: vec3 }),
  z.object({ kind: z.literal("arc"), through: vec3, to: vec3 }),
]);
/** Polyline (legacy) or mixed line/arc spine (G4). */
const spinePath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("polyline"), points: z.array(vec3) }),
  z.object({ kind: z.literal("path"), start: vec3, segments: z.array(spineSegment).min(1) }),
]);

const base = {
  id: z.string().min(1),
  name: z.string().optional(),
  deps: z.array(z.string()).optional(),
  suppressed: z.boolean().optional(),
};

// Recursive feature schema — `boolean.toolFeatures` is a full sub-document, so the
/** Shared optional placement params for the round primitives (§4.11). */
const primitivePlacement = {
  ox: z.number().optional(),
  oy: z.number().optional(),
  oz: z.number().optional(),
  ax: z.number().optional(),
  ay: z.number().optional(),
  az: z.number().optional(),
  angle: z.number().optional(),
};

/** How a primitive combines with the current body (mirrors extrude's data.op). */
const primitiveData = z
  .object({ op: z.enum(["new", "join", "cut", "intersect"]).optional() })
  .optional();

// union references itself via z.lazy (the standard zod recursion pattern).
const featureSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      ...base,
      type: z.literal("box"),
      params: z.object({ dx: z.number(), dy: z.number(), dz: z.number() }),
      data: z.unknown().optional(),
    }),
    // Round primitives (§4.11) — analytic solids needing no sketch. Placement
    // (ox,oy,oz / ax,ay,az) and the partial-sweep `angle` are optional and
    // default to the origin, +Z, and a full revolution. `data.op` combines with
    // the current body: "join" (default), "cut", "intersect", or "new".
    z.object({
      ...base,
      type: z.literal("cylinder"),
      params: z.object({ radius: z.number(), height: z.number(), ...primitivePlacement }),
      data: primitiveData,
    }),
    z.object({
      ...base,
      type: z.literal("sphere"),
      params: z.object({ radius: z.number(), ...primitivePlacement }),
      data: primitiveData,
    }),
    z.object({
      ...base,
      type: z.literal("cone"),
      params: z.object({
        radius1: z.number(),
        radius2: z.number(),
        height: z.number(),
        ...primitivePlacement,
      }),
      data: primitiveData,
    }),
    z.object({
      ...base,
      type: z.literal("torus"),
      params: z.object({
        majorRadius: z.number(),
        minorRadius: z.number(),
        ...primitivePlacement,
      }),
      data: primitiveData,
    }),
    z.object({
      ...base,
      type: z.literal("sketch"),
      params: numParams.optional(),
      data: z.object({ profile, plane: sketchPlaneSpec.optional(), model: z.unknown().optional() }),
    }),
    z
      .object({
        ...base,
        type: z.literal("extrude"),
        // height optional when toFace is set (true up-to-face needs no blind distance).
        params: z.object({
          height: z.number().optional(),
          back: z.number().optional(),
          draftAngle: z.number().optional(),
        }),
        data: z
          .object({
            direction: vec3.optional(),
            directionEdge: edgeRef.optional(),
            toFace: faceRef.optional(),
            // "join" fuses the pad with the existing body; "new" replaces it.
            // Unset: rebuild joins when a solid already exists, else creates a new body (C1).
            op: z.enum(["new", "join", "cut", "intersect"]).optional(),
          })
          .optional(),
      })
      .superRefine((val, ctx) => {
        const hasToFace = val.data?.toFace != null;
        if (!hasToFace && (val.params.height == null || !Number.isFinite(val.params.height))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "extrude: height is required unless data.toFace is set",
            path: ["params", "height"],
          });
        }
      }),
    z.object({
      ...base,
      type: z.literal("rib"),
      params: z.object({ length: z.number() }),
      data: z
        .object({
          direction: vec3.optional(),
          sketchId: z.string().optional(),
          op: z.enum(["new", "join", "cut", "intersect"]).optional(),
        })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("revolve"),
      params: z.object({
        angle: z.number(),
        // Axis direction (unitless) + origin in length units (mm authoring / SI after convert).
        ax: z.number().optional(),
        ay: z.number().optional(),
        az: z.number().optional(),
        ox: z.number().optional(),
        oy: z.number().optional(),
        oz: z.number().optional(),
      }),
      data: z
        .object({
          // Edge-driven axis (C2); rebuild re-resolves origin+direction each time.
          axisEdge: edgeRef.optional(),
          // Join/new parity with extrude (C2); unset joins when a solid exists.
          op: z.enum(["new", "join", "cut", "intersect"]).optional(),
        })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("cut"),
      // `back` = two-sided pocket (G5); direction / directionEdge mirror extrude.
      params: z.object({
        depth: z.number(),
        back: z.number().optional(),
        draftAngle: z.number().optional(),
      }),
      data: z.object({ direction: vec3.optional(), directionEdge: edgeRef.optional() }).optional(),
    }),
    z.object({
      ...base,
      type: z.literal("fillet"),
      // radius2 = variable end radius along the edge (C8 / rebuild radius2 → endRadius).
      params: z.object({ radius: z.number(), radius2: z.number().optional() }),
      data: z
        .object({ edges: z.array(edgeRef).optional(), selector: z.unknown().optional() })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("chamfer"),
      // distance2 + data.face = two-distance chamfer (C8).
      params: z.object({ distance: z.number(), distance2: z.number().optional() }),
      data: z
        .object({
          edges: z.array(edgeRef).optional(),
          selector: z.unknown().optional(),
          face: faceRef.optional(),
        })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("shell"),
      params: z.object({ thickness: z.number() }),
      data: z
        .object({
          faces: z.array(faceRef).optional(),
          selector: z.unknown().optional(),
          // "outward" grows walls; default inward hollows (G13).
          direction: z.enum(["inward", "outward"]).optional(),
        })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("draft"),
      params: z.object({ angle: z.number() }),
      // face (singular) for back-compat; faces[] for multi-face draft (G9).
      data: z.object({
        face: faceRef.optional(),
        faces: z.array(faceRef).optional(),
        pull: vec3.optional(),
        neutralOrigin: vec3.optional(),
        neutralNormal: vec3.optional(),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("hole"),
      // §13.2 hole: diameter + depth (or throughAll) + optional counterbore /
      // countersink / drill-tip dimensions.
      params: z.object({
        diameter: z.number(),
        depth: z.number().optional(),
        counterboreDiameter: z.number().optional(),
        counterboreDepth: z.number().optional(),
        countersinkDiameter: z.number().optional(),
        countersinkAngle: z.number().optional(),
        tipAngle: z.number().optional(),
      }),
      data: z.object({
        origin: vec3,
        axis: vec3,
        kind: z.enum(["simple", "counterbore", "countersink", "spotface"]).optional(),
        throughAll: z.boolean().optional(),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("transform"),
      params: numParams.optional(),
      data: z.unknown().optional(),
    }),
    // Uniform resize about a pivot (§2.5). `factor` is required (a scale with no
    // factor is meaningless); px/py/pz default to the origin.
    z.object({
      ...base,
      type: z.literal("thicken"),
      // §13.2/§14: open face/shell → solid plate of wall `thickness`.
      params: z.object({ thickness: z.number() }),
      data: z
        .object({
          bothSides: z.boolean().optional(),
        })
        .optional(),
    }),
    // §14 surface loft — same sections as solid loft; open shell result.
    z.object({
      ...base,
      type: z.literal("surfaceLoft"),
      params: numParams.optional(),
      data: z.object({
        sections: z
          .array(
            z.object({
              profile,
              z: z.number().optional(),
              plane: sketchPlaneSpec.optional(),
            }),
          )
          .min(2),
        ruled: z.boolean().optional(),
        op: z.enum(["new"]).optional(),
      }),
    }),
    // §14 open pipe shell (sweep without MakeSolid).
    z.object({
      ...base,
      type: z.literal("surfaceSweep"),
      params: numParams.optional(),
      data: z.object({
        profile,
        path: spinePath.optional(),
        pathEdges: z.array(edgeRef).optional(),
        plane: sketchPlaneSpec.optional(),
        mode: z.enum(["correctedFrenet", "frenet", "fixed"]).optional(),
        transition: z.enum(["right", "round", "transformed"]).optional(),
        op: z.enum(["new"]).optional(),
      }),
    }),
    // §14 surface of revolution from a profile wire.
    z.object({
      ...base,
      type: z.literal("surfaceRevolve"),
      params: z.object({
        angle: z.number(),
        ox: z.number().optional(),
        oy: z.number().optional(),
        oz: z.number().optional(),
        ax: z.number().optional(),
        ay: z.number().optional(),
        az: z.number().optional(),
      }),
      data: z
        .object({
          profile: profile.optional(),
          plane: sketchPlaneSpec.optional(),
          axisEdge: edgeRef.optional(),
          sketchId: z.string().optional(),
          op: z.enum(["new"]).optional(),
        })
        .optional(),
    }),
    // §14 B-spline face through a rectangular point grid (mm authoring → SI).
    z.object({
      ...base,
      type: z.literal("surfaceFromPoints"),
      params: z
        .object({
          degU: z.number().optional(),
          degV: z.number().optional(),
          tolerance: z.number().optional(),
        })
        .optional(),
      data: z.object({
        grid: z.array(z.array(vec3).min(2)).min(2),
        op: z.enum(["new"]).optional(),
      }),
    }),
    // §14 offset the current face/shell by `distance` (still a sheet).
    z.object({
      ...base,
      type: z.literal("offsetSurface"),
      params: z.object({ distance: z.number() }),
      data: z.unknown().optional(),
    }),
    // §14 sew current body's faces into a shell within `tolerance`.
    z.object({
      ...base,
      type: z.literal("sew"),
      params: z.object({ tolerance: z.number().optional() }).optional(),
      data: z.unknown().optional(),
    }),
    // §14 promote a closed shell to a solid.
    z.object({
      ...base,
      type: z.literal("solidify"),
      params: numParams.optional(),
      data: z.unknown().optional(),
    }),
    // §14 free-edge fill (MakeFilling) over ≥3 boundary edges.
    z.object({
      ...base,
      type: z.literal("patch"),
      params: numParams.optional(),
      data: z
        .object({
          edges: z.array(edgeRef).min(3),
          continuity: z.enum(["c0", "c1", "g1", "c2", "g2"]).optional(),
        })
        .optional(),
    }),
    // §14 keep-one-side plane trim.
    z.object({
      ...base,
      type: z.literal("trim"),
      params: numParams.optional(),
      data: z
        .object({
          plane: z.object({
            origin: vec3,
            normal: vec3,
            xAxis: vec3.optional(),
          }),
          keep: z.enum(["positive", "negative"]).optional(),
        })
        .optional(),
    }),
    // §14 restore the full natural bounds of a single B-spline face.
    z.object({
      ...base,
      type: z.literal("untrim"),
      params: numParams.optional(),
      data: z.unknown().optional(),
    }),
    // §14 extend a selected B-spline boundary by a physical length.
    z.object({
      ...base,
      type: z.literal("extendSurface"),
      params: z.object({ length: z.number() }),
      data: z.object({
        edge: edgeRef,
        continuity: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("scale"),
      params: z.object({
        factor: z.number(),
        px: z.number().optional(),
        py: z.number().optional(),
        pz: z.number().optional(),
      }),
      data: z.unknown().optional(),
    }),
    z.object({
      ...base,
      type: z.literal("mirror"),
      params: numParams.optional(),
      data: z.unknown().optional(),
    }),
    z.object({
      ...base,
      type: z.literal("linearPattern"),
      params: z.object({
        spacing: z.number(),
        count: z.number(),
        dx: z.number().optional(),
        dy: z.number().optional(),
        dz: z.number().optional(),
      }),
      data: z.unknown().optional(),
    }),
    z.object({
      ...base,
      type: z.literal("circularPattern"),
      params: z.object({
        count: z.number(),
        angle: z.number().optional(),
        ox: z.number().optional(),
        oy: z.number().optional(),
        oz: z.number().optional(),
        ax: z.number().optional(),
        ay: z.number().optional(),
        az: z.number().optional(),
      }),
      data: z.unknown().optional(),
    }),
    // §13.2 patternAlongPath — count along a spine (polyline/path or pathEdges).
    z.object({
      ...base,
      type: z.literal("pathPattern"),
      params: z.object({ count: z.number() }),
      data: z
        .object({
          path: spinePath.optional(),
          pathEdges: z.array(edgeRef).optional(),
          align: z.boolean().optional(),
          toolFeatures: z.array(featureSchema).optional(),
        })
        .optional(),
    }),
    // §13.2 split — keep both sides of a plane/tool cut as multi-body.
    z.object({
      ...base,
      type: z.literal("split"),
      params: numParams.optional(),
      data: z
        .object({
          plane: z
            .object({
              origin: vec3,
              normal: vec3,
              xAxis: vec3.optional(),
            })
            .optional(),
          toolFeatures: z.array(featureSchema).optional(),
        })
        .optional(),
    }),
    // §13.2 sectionCurves — body ∩ plane as edge compound.
    z.object({
      ...base,
      type: z.literal("section"),
      params: numParams.optional(),
      data: z.object({
        plane: z.object({
          origin: vec3,
          normal: vec3,
          xAxis: vec3.optional(),
        }),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("loft"),
      params: numParams.optional(),
      // Sections: legacy `{z, profile}` on world-XY, or `{plane, profile}` (G6).
      data: z.object({
        sections: z
          .array(
            z.object({
              profile,
              z: z.number().optional(),
              plane: sketchPlaneSpec.optional(),
            }),
          )
          .min(2),
        ruled: z.boolean().optional(),
        op: z.enum(["new", "join", "cut", "intersect"]).optional(),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("sweep"),
      params: numParams.optional(),
      // Optional plane (G3) + MakePipeShell mode/transition (G8).
      // Spine: path (polyline/path), pathEdges, or helix (§13.2 — not a SpinePath kind).
      data: z.object({
        profile,
        path: spinePath.optional(),
        pathEdges: z.array(edgeRef).optional(),
        helix: z
          .object({
            radius: z.number(),
            pitch: z.number(),
            turns: z.number(),
            handedness: z.enum(["right", "left"]),
            taperAngle: z.number().optional(),
          })
          .optional(),
        plane: sketchPlaneSpec.optional(),
        mode: z.enum(["correctedFrenet", "frenet", "fixed"]).optional(),
        transition: z.enum(["right", "round", "transformed"]).optional(),
        op: z.enum(["new", "join", "cut", "intersect"]).optional(),
      }),
    }),
    z.object({
      ...base,
      type: z.literal("boolean"),
      params: numParams.optional(),
      data: z
        .object({
          op: z.enum(["union", "subtract", "intersect"]).optional(),
          toolFeatures: z.array(featureSchema).optional(),
          dx: z.number().optional(),
          dy: z.number().optional(),
          dz: z.number().optional(),
          tx: z.number().optional(),
          ty: z.number().optional(),
          tz: z.number().optional(),
        })
        .optional(),
    }),
    z.object({
      ...base,
      type: z.literal("importStep"),
      params: numParams.optional(),
      data: z.object({ step: z.string().min(1) }),
    }),
    z.object({
      ...base,
      type: z.literal("placement"),
      params: numParams.optional(),
      data: z.unknown().optional(),
    }),
    // §15 freeform NURBS surface body. data.surface is NurbsSurface JSON (mm
    // control points in authoring → SI via convData); data.kind names the
    // generator used to create it (plane/cylinder/sphere) when surface is omitted.
    z.object({
      ...base,
      type: z.literal("freeform"),
      params: z
        .object({
          uSize: z.number().optional(),
          vSize: z.number().optional(),
          radius: z.number().optional(),
          height: z.number().optional(),
          ox: z.number().optional(),
          oy: z.number().optional(),
          oz: z.number().optional(),
          ax: z.number().optional(),
          ay: z.number().optional(),
          az: z.number().optional(),
          resU: z.number().optional(),
          resV: z.number().optional(),
        })
        .optional(),
      data: z
        .object({
          kind: z.enum(["plane", "cylinder", "sphere", "custom"]).optional(),
          surface: z
            .object({
              degU: z.number(),
              degV: z.number(),
              knotsU: z.array(z.number()),
              knotsV: z.array(z.number()),
              controlNet: z.array(z.array(vec3)),
              weights: z.array(z.array(z.number())).optional(),
            })
            .optional(),
          uDir: vec3.optional(),
          vDir: vec3.optional(),
          op: z.enum(["new", "join", "cut", "intersect"]).optional(),
        })
        .optional(),
    }),
  ]),
);

// R11: real assembly validation (was z.unknown()). The schema accepts an
// `assembly` — component instances + mates + joints — and it flows straight into
// replaceDocument, so it must be structurally validated, not passed through blind.
// Mirrors apps/plastiq/src/assembly/model.ts (AssemblyModel).
const asmQuat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const asmMateRef = z.object({ instance: z.string(), point: vec3.optional(), dir: vec3.optional() });
const asmMate = z.union([
  z.object({ id: z.string(), kind: z.literal("coincident"), a: asmMateRef, b: asmMateRef }),
  z.object({
    id: z.string(),
    kind: z.literal("distance"),
    a: asmMateRef,
    b: asmMateRef,
    value: z.number(),
  }),
  z.object({ id: z.string(), kind: z.literal("parallel"), a: asmMateRef, b: asmMateRef }),
  z.object({ id: z.string(), kind: z.literal("perpendicular"), a: asmMateRef, b: asmMateRef }),
  z.object({
    id: z.string(),
    kind: z.literal("angle"),
    a: asmMateRef,
    b: asmMateRef,
    value: z.number(),
  }),
  z.object({ id: z.string(), kind: z.literal("concentric"), a: asmMateRef, b: asmMateRef }),
]);
const asmJoint = z.object({
  id: z.string(),
  kind: z.enum(["revolute", "prismatic", "cylindrical", "fixed", "ball", "planar"]),
  parent: z.string(),
  child: z.string(),
  origin: vec3,
  axis: vec3,
  limits: z.object({ lower: z.number().optional(), upper: z.number().optional() }).optional(),
});
const asmInstance = z.object({
  id: z.string(),
  name: z.string(),
  part: z.string().optional(),
  pose: z.object({ position: vec3, orientation: asmQuat }),
  fixed: z.boolean().optional(),
});
const assemblySchema = z.object({
  instances: z.array(asmInstance),
  mates: z.array(asmMate),
  joints: z.array(asmJoint),
});

/** The structural schema shared by the authoring (mm/deg) and SI documents — they
 * have the same shape (both are EditorFeature[]); units differ only semantically. */
const documentSchema = z.object({
  features: z.array(featureSchema),
  params: z.record(z.string(), z.number()),
  assembly: assemblySchema.optional(),
});

/** Validates an AI-authored document (values in mm/deg) before conversion (FR-7). */
export const authoringDocumentSchema = documentSchema;
/** Validates a built SI CadDocument — the structural gate before loadDocument. */
export const cadDocumentSchema = documentSchema;

// ── mm ↔ SI conversion (the single choke-point — spec R-7) ──────────────────────

// LENGTH_PARAMS / ANGLE_PARAMS are the shared feature unit semantics
// (store/featureUnits.ts) — one source of truth for this converter and the
// PropertiesPanel mm/deg display.

type Scale = { len: (n: number) => number; ang: (n: number) => number };

function convParams(
  type: string,
  params: Record<string, number> | undefined,
  s: Scale,
): Record<string, number> | undefined {
  if (!params) return params;
  const lens = new Set(LENGTH_PARAMS[type] ?? []);
  const angs = new Set(ANGLE_PARAMS[type] ?? []);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = lens.has(k) ? s.len(v) : angs.has(k) ? s.ang(v) : v;
  }
  return out;
}

type V2 = [number, number];
type V3 = [number, number, number];
const cv2 = (v: V2, L: (n: number) => number): V2 => [L(v[0]), L(v[1])];
const cv3 = (v: V3, L: (n: number) => number): V3 => [L(v[0]), L(v[1]), L(v[2])];

/** Scale every coordinate of a derived profile (all coords are lengths). */
function convProfile(p: unknown, L: (n: number) => number): unknown {
  const prof = p as Record<string, unknown>;
  if (prof.kind === "circle") {
    return { ...prof, center: cv2(prof.center as V2, L), radius: L(prof.radius as number) };
  }
  const segs = (prof.segments as Record<string, unknown>[]).map((seg) => {
    if (seg.kind === "line") return { ...seg, to: cv2(seg.to as V2, L) };
    if (seg.kind === "arc")
      return { ...seg, through: cv2(seg.through as V2, L), to: cv2(seg.to as V2, L) };
    return {
      ...seg,
      through: (seg.through as V2[]).map((t) => cv2(t, L)),
      to: cv2(seg.to as V2, L),
    };
  });
  return { ...prof, start: cv2(prof.start as V2, L), segments: segs };
}

function convData(
  type: string,
  data: Record<string, unknown> | undefined,
  s: Scale,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const L = s.len;
  const d: Record<string, unknown> = { ...data };
  switch (type) {
    case "sketch": {
      if (d.profile) d.profile = convProfile(d.profile, L);
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && typeof plane.offset === "number")
        d.plane = { ...plane, offset: L(plane.offset) };
      break;
    }
    case "loft":
    case "surfaceLoft": {
      if (Array.isArray(d.sections)) {
        d.sections = (d.sections as Record<string, unknown>[]).map((sec) => {
          const out: Record<string, unknown> = {
            ...sec,
            profile: convProfile(sec.profile, L),
          };
          if (typeof sec.z === "number") out.z = L(sec.z);
          const plane = sec.plane as Record<string, unknown> | undefined;
          if (plane && typeof plane.offset === "number") {
            out.plane = { ...plane, offset: L(plane.offset) };
          }
          return out;
        });
      }
      break;
    }
    case "sweep":
    case "surfaceSweep": {
      if (d.profile) d.profile = convProfile(d.profile, L);
      const path = d.path as Record<string, unknown> | undefined;
      if (path) {
        if (path.kind === "polyline" && Array.isArray(path.points)) {
          d.path = { ...path, points: (path.points as V3[]).map((p) => cv3(p, L)) };
        } else if (path.kind === "path" && Array.isArray(path.segments)) {
          d.path = {
            kind: "path",
            start: cv3(path.start as V3, L),
            segments: (path.segments as Record<string, unknown>[]).map((seg) => {
              if (seg.kind === "arc") {
                return {
                  kind: "arc",
                  through: cv3(seg.through as V3, L),
                  to: cv3(seg.to as V3, L),
                };
              }
              return { kind: "line", to: cv3(seg.to as V3, L) };
            }),
          };
        }
      }
      // §13.2 helix spine lengths (mm → m); taperAngle is deg → rad; turns unitless.
      const helix = d.helix as Record<string, unknown> | undefined;
      if (helix && type === "sweep") {
        const next: Record<string, unknown> = {
          ...helix,
          radius: L(Number(helix.radius)),
          pitch: L(Number(helix.pitch)),
        };
        if (typeof helix.taperAngle === "number") {
          next.taperAngle = s.ang(helix.taperAngle);
        }
        d.helix = next;
      }
      // Profile plane offset is a length (same as sketch.plane).
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && typeof plane.offset === "number")
        d.plane = { ...plane, offset: L(plane.offset) };
      break;
    }
    case "surfaceRevolve": {
      if (d.profile) d.profile = convProfile(d.profile, L);
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && typeof plane.offset === "number")
        d.plane = { ...plane, offset: L(plane.offset) };
      break;
    }
    case "surfaceFromPoints": {
      // Rectangular grid poles are lengths (mm ↔ m).
      if (Array.isArray(d.grid)) {
        d.grid = (d.grid as V3[][]).map((row) => row.map((p) => cv3(p, L)));
      }
      break;
    }
    case "draft": {
      if (Array.isArray(d.neutralOrigin)) d.neutralOrigin = cv3(d.neutralOrigin as V3, L);
      break;
    }
    case "boolean": {
      if (Array.isArray(d.toolFeatures)) {
        d.toolFeatures = (d.toolFeatures as AuthoringFeature[]).map((f) => convFeature(f, s));
      }
      break;
    }
    case "pathPattern": {
      // Spine polyline/path points are lengths (same as sweep.path).
      const path = d.path as Record<string, unknown> | undefined;
      if (path) {
        if (path.kind === "polyline" && Array.isArray(path.points)) {
          d.path = { ...path, points: (path.points as V3[]).map((p) => cv3(p, L)) };
        } else if (path.kind === "path" && Array.isArray(path.segments)) {
          d.path = {
            kind: "path",
            start: cv3(path.start as V3, L),
            segments: (path.segments as Record<string, unknown>[]).map((seg) => {
              if (seg.kind === "arc") {
                return {
                  kind: "arc",
                  through: cv3(seg.through as V3, L),
                  to: cv3(seg.to as V3, L),
                };
              }
              return { kind: "line", to: cv3(seg.to as V3, L) };
            }),
          };
        }
      }
      if (Array.isArray(d.toolFeatures)) {
        d.toolFeatures = (d.toolFeatures as AuthoringFeature[]).map((f) => convFeature(f, s));
      }
      break;
    }
    case "split": {
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && Array.isArray(plane.origin)) {
        d.plane = {
          ...plane,
          origin: cv3(plane.origin as V3, L),
          // normal / xAxis are unitless directions.
        };
      }
      if (Array.isArray(d.toolFeatures)) {
        d.toolFeatures = (d.toolFeatures as AuthoringFeature[]).map((f) => convFeature(f, s));
      }
      break;
    }
    case "section":
    case "trim": {
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && Array.isArray(plane.origin)) {
        d.plane = {
          ...plane,
          origin: cv3(plane.origin as V3, L),
        };
      }
      break;
    }
    case "freeform": {
      // NurbsSurface control points are lengths (mm authoring → SI metres).
      // Knots/degrees/weights are unitless. uDir/vDir are directions (unitless).
      const surface = d.surface as Record<string, unknown> | undefined;
      if (surface && Array.isArray(surface.controlNet)) {
        d.surface = {
          ...surface,
          controlNet: (surface.controlNet as V3[][]).map((row) => row.map((p) => cv3(p, L))),
        };
      }
      break;
    }
    // extrude.direction / directionEdge / toFace, dress-up refs, importStep.step,
    // boolean.op, loft.ruled — all unitless or SI selection artifacts: passthrough.
  }
  return d;
}

function convFeature(f: AuthoringFeature, s: Scale): AuthoringFeature {
  const out: AuthoringFeature = { ...f };
  const params = convParams(f.type, f.params, s);
  const data = convData(f.type, f.data, s);
  if (params !== undefined) out.params = params;
  else delete out.params;
  if (data !== undefined) out.data = data;
  else delete out.data;
  return out;
}

/** Authoring (mm/deg) → kernel SI CadDocument. The only place lengths/angles scale. */
export function toCadDocument(doc: AuthoringDocument): CadDocument {
  const s: Scale = { len: mm, ang: deg };
  const out: CadDocument = {
    features: doc.features.map((f) => convFeature(f, s) as EditorFeature),
    params: { ...doc.params },
  };
  if (doc.assembly !== undefined) (out as { assembly?: unknown }).assembly = doc.assembly;
  return out;
}

/** SI CadDocument → authoring (mm/deg) — exact inverse, for edit-mode context (FR-6a). */
export function toAuthoringDoc(doc: CadDocument): AuthoringDocument {
  const s: Scale = { len: toMm, ang: toDeg };
  const out: AuthoringDocument = {
    features: doc.features.map((f) => convFeature(f as AuthoringFeature, s)),
    params: { ...doc.params },
  };
  if ((doc as { assembly?: unknown }).assembly !== undefined) {
    out.assembly = (doc as { assembly?: unknown }).assembly;
  }
  return out;
}
