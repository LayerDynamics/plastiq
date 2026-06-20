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
const spinePath = z.object({ kind: z.literal("polyline"), points: z.array(vec3) });

const base = {
  id: z.string().min(1),
  name: z.string().optional(),
  deps: z.array(z.string()).optional(),
  suppressed: z.boolean().optional(),
};

// Recursive feature schema — `boolean.toolFeatures` is a full sub-document, so the
// union references itself via z.lazy (the standard zod recursion pattern).
const featureSchema: z.ZodTypeAny = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("box"), params: z.object({ dx: z.number(), dy: z.number(), dz: z.number() }), data: z.unknown().optional() }),
    z.object({
      ...base,
      type: z.literal("sketch"),
      params: numParams.optional(),
      data: z.object({ profile, plane: sketchPlaneSpec.optional(), model: z.unknown().optional() }),
    }),
    z.object({
      ...base,
      type: z.literal("extrude"),
      params: z.object({ height: z.number(), back: z.number().optional() }),
      data: z.object({ direction: vec3.optional(), directionEdge: edgeRef.optional(), toFace: faceRef.optional() }).optional(),
    }),
    z.object({ ...base, type: z.literal("revolve"), params: z.object({ angle: z.number(), ax: z.number().optional(), ay: z.number().optional(), az: z.number().optional() }), data: z.unknown().optional() }),
    z.object({ ...base, type: z.literal("cut"), params: z.object({ depth: z.number() }), data: z.unknown().optional() }),
    z.object({ ...base, type: z.literal("fillet"), params: z.object({ radius: z.number() }), data: z.object({ edges: z.array(edgeRef).optional(), selector: z.unknown().optional() }).optional() }),
    z.object({ ...base, type: z.literal("chamfer"), params: z.object({ distance: z.number() }), data: z.object({ edges: z.array(edgeRef).optional(), selector: z.unknown().optional() }).optional() }),
    z.object({ ...base, type: z.literal("shell"), params: z.object({ thickness: z.number() }), data: z.object({ faces: z.array(faceRef).optional(), selector: z.unknown().optional() }).optional() }),
    z.object({
      ...base,
      type: z.literal("draft"),
      params: z.object({ angle: z.number() }),
      data: z.object({ face: faceRef, pull: vec3.optional(), neutralOrigin: vec3.optional(), neutralNormal: vec3.optional() }),
    }),
    z.object({ ...base, type: z.literal("transform"), params: numParams.optional(), data: z.unknown().optional() }),
    z.object({ ...base, type: z.literal("mirror"), params: numParams.optional(), data: z.unknown().optional() }),
    z.object({ ...base, type: z.literal("linearPattern"), params: z.object({ spacing: z.number(), count: z.number(), dx: z.number().optional(), dy: z.number().optional(), dz: z.number().optional() }), data: z.unknown().optional() }),
    z.object({ ...base, type: z.literal("circularPattern"), params: z.object({ count: z.number(), angle: z.number().optional(), ox: z.number().optional(), oy: z.number().optional(), oz: z.number().optional(), ax: z.number().optional(), ay: z.number().optional(), az: z.number().optional() }), data: z.unknown().optional() }),
    z.object({
      ...base,
      type: z.literal("loft"),
      params: numParams.optional(),
      data: z.object({ sections: z.array(z.object({ z: z.number(), profile })).min(2), ruled: z.boolean().optional() }),
    }),
    z.object({ ...base, type: z.literal("sweep"), params: numParams.optional(), data: z.object({ profile, path: spinePath }) }),
    z.object({
      ...base,
      type: z.literal("boolean"),
      params: numParams.optional(),
      data: z.object({
        op: z.enum(["union", "subtract", "intersect"]).optional(),
        toolFeatures: z.array(featureSchema).optional(),
        dx: z.number().optional(), dy: z.number().optional(), dz: z.number().optional(),
        tx: z.number().optional(), ty: z.number().optional(), tz: z.number().optional(),
      }).optional(),
    }),
    z.object({ ...base, type: z.literal("importStep"), params: numParams.optional(), data: z.object({ step: z.string().min(1) }) }),
    z.object({ ...base, type: z.literal("placement"), params: numParams.optional(), data: z.unknown().optional() }),
  ]),
);

/** The structural schema shared by the authoring (mm/deg) and SI documents — they
 * have the same shape (both are EditorFeature[]); units differ only semantically. */
const documentSchema = z.object({
  features: z.array(featureSchema),
  params: z.record(z.string(), z.number()),
  assembly: z.unknown().optional(),
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

function convParams(type: string, params: Record<string, number> | undefined, s: Scale): Record<string, number> | undefined {
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
    if (seg.kind === "arc") return { ...seg, through: cv2(seg.through as V2, L), to: cv2(seg.to as V2, L) };
    return { ...seg, through: (seg.through as V2[]).map((t) => cv2(t, L)), to: cv2(seg.to as V2, L) };
  });
  return { ...prof, start: cv2(prof.start as V2, L), segments: segs };
}

function convData(type: string, data: Record<string, unknown> | undefined, s: Scale): Record<string, unknown> | undefined {
  if (!data) return data;
  const L = s.len;
  const d: Record<string, unknown> = { ...data };
  switch (type) {
    case "sketch": {
      if (d.profile) d.profile = convProfile(d.profile, L);
      const plane = d.plane as Record<string, unknown> | undefined;
      if (plane && typeof plane.offset === "number") d.plane = { ...plane, offset: L(plane.offset) };
      break;
    }
    case "loft": {
      if (Array.isArray(d.sections)) {
        d.sections = (d.sections as Record<string, unknown>[]).map((sec) => ({
          ...sec,
          z: L(sec.z as number),
          profile: convProfile(sec.profile, L),
        }));
      }
      break;
    }
    case "sweep": {
      if (d.profile) d.profile = convProfile(d.profile, L);
      const path = d.path as Record<string, unknown> | undefined;
      if (path && Array.isArray(path.points)) {
        d.path = { ...path, points: (path.points as V3[]).map((p) => cv3(p, L)) };
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
    // extrude.direction / directionEdge / toFace, dress-up refs, importStep.step,
    // boolean.op, loft.ruled — all unitless or SI selection artifacts: passthrough.
  }
  return d;
}

function convFeature(f: AuthoringFeature, s: Scale): AuthoringFeature {
  const out: AuthoringFeature = { ...f };
  const params = convParams(f.type, f.params, s);
  const data = convData(f.type, f.data, s);
  if (params !== undefined) out.params = params; else delete out.params;
  if (data !== undefined) out.data = data; else delete out.data;
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
