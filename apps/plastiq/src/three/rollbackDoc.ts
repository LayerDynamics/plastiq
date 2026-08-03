// Rollback-aware document helpers (SPEC-6 FR-25 / R2 · P1).
//
// The viewport renders only the features up to the rollback point. These pure
// helpers keep every downstream consumer — the geometry rebuild, the change
// signature, and (the R2 fix) export / lowering / Simulate — tied to that SAME
// sliced view, so the file you export and the world you simulate always match
// the geometry on screen. Extracted from Viewport.tsx so the slicing logic is
// unit-testable without mounting the three.js component.

import { PLACEMENT_TYPE, type CadDocument } from "../store/types.js";

/** The state fields the rollback helpers read. */
export interface RollbackState {
  features: CadDocument["features"];
  rollbackIndex: number | null;
}

/** Features that actually build, honouring the rollback point (FR-25). */
export function buildFeatures(s: RollbackState): CadDocument["features"] {
  return s.rollbackIndex == null ? s.features : s.features.slice(0, s.rollbackIndex);
}

/** Signature of every geometry input: the rollback-sliced features (placement
 * excluded) plus global parameters. A pure pose change therefore skips OCCT,
 * while a rollback move or expression-driving parameter edit rebuilds. */
export function geometrySignature(s: RollbackState & Pick<CadDocument, "params">): string {
  return JSON.stringify({
    features: buildFeatures(s).filter((f) => f.type !== PLACEMENT_TYPE),
    params: s.params,
  });
}

/**
 * The document as it should EXPORT / LOWER / SIMULATE (R2 · P1 fix).
 *
 * The viewport builds only `buildFeatures()` (sliced at the rollback point), but
 * export, lowering, and Simulate previously read the FULL `toDocument()` — so
 * with a rollback active the exported STEP/IGES/glTF and the sim world silently
 * contained geometry the screen did not show (a WYSIWYG break). Slicing here ties
 * all three seams to exactly what is rendered: what you see is what you export
 * and simulate. Returns the document unchanged (no clone) when no rollback is
 * active, so the common path is allocation-free.
 */
export function rolledBackDocument(s: RollbackState & { toDocument(): CadDocument }): CadDocument {
  const doc = s.toDocument();
  if (s.rollbackIndex == null) return doc;
  return { ...doc, features: buildFeatures(s) };
}
