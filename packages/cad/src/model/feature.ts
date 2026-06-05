// Parametric feature abstraction (SPEC-4 FR-24). A feature reads named model
// parameters and the results of upstream features it depends on, and produces a
// result (e.g. a Solid). Concrete features (extrude/revolve/boolean/…) implement
// `evaluate`; the Model (model.ts) orders + re-evaluates them.

export interface FeatureContext {
  /** Current model parameters by name. */
  readonly params: ReadonlyMap<string, number>;
  /** Results of already-evaluated upstream features, keyed by feature id. */
  readonly results: ReadonlyMap<string, unknown>;
}

export interface Feature {
  /** Unique, stable id within the model. */
  readonly id: string;
  /** Ids of upstream features this one consumes (must evaluate first). */
  readonly deps: readonly string[];
  /** Evaluate the feature; throw to signal failure (isolated by the Model). */
  evaluate(ctx: FeatureContext): unknown;
}

export interface FeatureStatus {
  readonly id: string;
  readonly ok: boolean;
  /** Failure reason when `ok` is false. */
  readonly error?: string;
}
