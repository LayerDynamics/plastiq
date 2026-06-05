// Reproducible model serialization (SPEC-4 FR-34, decision Q9). The JSON
// feature-tree is the source of truth: a `ModelDoc` is a declarative list of
// feature specs (type + params + deps) plus named parameters — fully
// serializable (the live `Feature.evaluate` closures are NOT). A registry maps
// each spec `type` to a builder that reconstructs the closure, so a doc can be
// serialized, reloaded, and rebuilt to byte-identical geometry (NFR-2).

import { subtract } from "../action/boolean.js";
import { translate } from "../action/transform.js";
import { canonicalize } from "../lower/canonical.js";
import type { Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import type { Feature } from "./feature.js";
import { Model } from "./model.js";

/** A declarative, serializable feature: a type + its params + upstream deps. */
export interface FeatureSpec {
  readonly id: string;
  readonly type: string;
  readonly deps?: readonly string[];
  /** Literal feature parameters (all finite numbers — serializable). */
  readonly params?: Readonly<Record<string, number>>;
}

/** A serializable model: named parameters + an ordered feature history. */
export interface ModelDoc {
  readonly params?: Readonly<Record<string, number>>;
  readonly features: readonly FeatureSpec[];
}

/** Builds a live `Feature` (with its `evaluate` closure) from a spec. */
export type FeatureBuilder = (oc: Occt, spec: FeatureSpec) => Feature;
export type FeatureRegistry = Readonly<Record<string, FeatureBuilder>>;

function num(spec: FeatureSpec, key: string): number {
  const v = spec.params?.[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`feature '${spec.id}': missing/invalid numeric param '${key}'`);
  }
  return v;
}

function dep(spec: FeatureSpec, i: number): string {
  const d = spec.deps?.[i];
  if (typeof d !== "string") throw new Error(`feature '${spec.id}': missing dep #${i}`);
  return d;
}

/**
 * Built-in serializable feature types. Each builder reconstructs the live
 * feature from its (literal) spec; results flow between features by id via the
 * model's `results` map.
 */
export function defaultFeatureRegistry(): FeatureRegistry {
  return {
    // An axis-aligned box (corner at origin) of params dx/dy/dz.
    box: (oc, spec) => ({
      id: spec.id,
      deps: spec.deps ?? [],
      evaluate: () => makeBox(oc, num(spec, "dx"), num(spec, "dy"), num(spec, "dz")),
    }),
    // Translate the upstream solid (dep #0) by (x, y, z).
    translate: (oc, spec) => ({
      id: spec.id,
      deps: spec.deps ?? [],
      evaluate: (ctx) => {
        const src = ctx.results.get(dep(spec, 0)) as Solid;
        return translate(oc, src, [num(spec, "x"), num(spec, "y"), num(spec, "z")]);
      },
    }),
    // Boolean subtract: dep #0 (target) − dep #1 (tool).
    subtract: (oc, spec) => ({
      id: spec.id,
      deps: spec.deps ?? [],
      evaluate: (ctx) => {
        const a = ctx.results.get(dep(spec, 0)) as Solid;
        const b = ctx.results.get(dep(spec, 1)) as Solid;
        const r = subtract(oc, a, b);
        if (!r.ok) throw new Error(`subtract '${spec.id}': ${r.error}`);
        return r.solid;
      },
    }),
  };
}

/** Canonical (stable-key, exact-float) JSON for a model doc. */
export function serializeModelDoc(doc: ModelDoc): string {
  return canonicalize(doc);
}

/** Parse + structurally validate a model doc (throws on malformed input, NFR-3). */
export function parseModelDoc(json: string): ModelDoc {
  const v: unknown = JSON.parse(json);
  if (typeof v !== "object" || v === null) throw new Error("model doc: not an object");
  const obj = v as Record<string, unknown>;
  const features = obj["features"];
  if (!Array.isArray(features)) throw new Error("model doc: 'features' must be an array");
  for (const f of features) {
    if (typeof f !== "object" || f === null) throw new Error("model doc: feature is not an object");
    const fr = f as Record<string, unknown>;
    if (typeof fr["id"] !== "string") throw new Error("model doc: feature missing string 'id'");
    if (typeof fr["type"] !== "string") throw new Error("model doc: feature missing string 'type'");
    if (fr["deps"] !== undefined && !Array.isArray(fr["deps"])) {
      throw new Error(`model doc: feature '${fr["id"] as string}' deps must be an array`);
    }
  }
  return v as ModelDoc;
}

/** Construct + rebuild a live `Model` from a doc using `registry`. */
export function buildModel(oc: Occt, doc: ModelDoc, registry: FeatureRegistry): Model {
  const model = new Model();
  for (const [name, value] of Object.entries(doc.params ?? {})) {
    model.setParam(name, value);
  }
  for (const spec of doc.features) {
    const builder = registry[spec.type];
    if (!builder) throw new Error(`unknown feature type '${spec.type}' for feature '${spec.id}'`);
    model.addFeature(builder(oc, spec));
  }
  return model;
}
