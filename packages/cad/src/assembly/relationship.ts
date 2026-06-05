// Parametric relationships (SPEC-4 FR-29). A `Relationship` couples one
// component/feature parameter to another by a linear equation
// `target = scale·source + offset` — the assembly-level equivalent of a driven
// dimension. (Linear covers the common cases; a general expression engine is a
// later extension.)

export interface Relationship {
  /** Name of the driving parameter. */
  readonly source: string;
  /** Name of the driven parameter. */
  readonly target: string;
  readonly scale: number;
  readonly offset: number;
}

export function makeRelationship(
  source: string,
  target: string,
  scale: number,
  offset = 0,
): Relationship {
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
    throw new Error("relationship scale/offset must be finite");
  }
  if (source === target) throw new Error(`relationship cannot couple "${source}" to itself`);
  return { source, target, scale, offset };
}

/** The driven (target) value for a given source value. */
export function evaluateRelationship(rel: Relationship, sourceValue: number): number {
  return rel.scale * sourceValue + rel.offset;
}
